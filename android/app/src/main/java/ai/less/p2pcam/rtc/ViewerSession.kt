package ai.less.p2pcam.rtc

import android.content.Context
import android.os.Handler
import android.os.Looper
import ai.less.p2pcam.net.Signal
import org.json.JSONObject
import org.webrtc.AudioTrack
import org.webrtc.DataChannel
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.PeerConnection
import org.webrtc.RtpTransceiver
import org.webrtc.SurfaceViewRenderer
import org.webrtc.VideoTrack
import java.nio.ByteBuffer

/**
 * This device acting as the monitoring app: answers the camera's offer, renders
 * the feed, and drives the camera over the data channel.
 */
class ViewerSession(
    private val context: Context,
    private val signal: Signal,
) {

    interface Listener {
        fun onLog(text: String, kind: String? = null)
        fun onConnected()
        fun onDisconnected(reason: String)
        fun onControlReady(ready: Boolean)
        fun onCameraState(facing: String, width: Int, height: Int, shots: Int, torchCapable: Boolean)
        fun onCaptureAck(ok: Boolean, name: String?, bytes: Int)
    }

    private val main = Handler(Looper.getMainLooper())
    private var pc: PeerConnection? = null
    private var dc: DataChannel? = null
    private val pendingIce = mutableListOf<IceCandidate>()

    private var micTrack: AudioTrack? = null
    private var micSource: org.webrtc.AudioSource? = null
    private var remoteVideo: VideoTrack? = null
    private var remoteAudio: AudioTrack? = null
    private var renderer: SurfaceViewRenderer? = null

    var listener: Listener? = null

    /** Talk-back starts closed; the mic only opens while Talk is held on. */
    var talking: Boolean = false
        set(value) {
            field = value
            micTrack?.setEnabled(value)
        }

    /**
     * Incoming audio starts muted on purpose. Two devices in one room with both
     * microphones live will howl.
     */
    var listening: Boolean = false
        set(value) {
            field = value
            remoteAudio?.setEnabled(value)
        }

    fun attachRenderer(view: SurfaceViewRenderer) {
        renderer = view
        remoteVideo?.addSink(view)
    }

    fun prepareMic() {
        if (micTrack != null) return
        micSource = Rtc.factory.createAudioSource(MediaConstraints())
        micTrack = Rtc.factory.createAudioTrack("a0", micSource).apply { setEnabled(false) }
    }

    // ------------------------------------------------------------- offer ----

    fun onOffer(data: JSONObject) {
        runCatching { pc?.close() }
        pc = null
        pendingIce.clear()

        val observer = object : Rtc.Obs() {
            override fun onIceCandidate(candidate: IceCandidate?) {
                candidate ?: return
                signal.send("ice", Rtc.candidateToJson(candidate))
            }

            override fun onTrack(transceiver: RtpTransceiver?) {
                val track = transceiver?.receiver?.track() ?: return
                main.post {
                    when (track) {
                        is VideoTrack -> {
                            remoteVideo = track
                            renderer?.let { track.addSink(it) }
                            listener?.onLog("video track attached", "media")
                        }
                        is AudioTrack -> {
                            remoteAudio = track
                            track.setEnabled(listening)
                            listener?.onLog("audio track attached", "media")
                        }
                    }
                }
            }

            override fun onDataChannel(channel: DataChannel?) {
                channel ?: return
                dc = channel
                channel.registerObserver(object : DataChannel.Observer {
                    override fun onBufferedAmountChange(amount: Long) = Unit
                    override fun onStateChange() {
                        val open = channel.state() == DataChannel.State.OPEN
                        main.post {
                            listener?.onControlReady(open)
                            if (open) {
                                listener?.onLog("control channel open", "ok")
                                send(JSONObject().put("cmd", "state"))
                            }
                        }
                    }
                    override fun onMessage(buffer: DataChannel.Buffer?) {
                        val b = buffer?.data ?: return
                        val bytes = ByteArray(b.remaining())
                        b.get(bytes)
                        main.post { onDeviceMessage(String(bytes, Charsets.UTF_8)) }
                    }
                })
            }

            override fun onConnectionChange(newState: PeerConnection.PeerConnectionState?) {
                main.post {
                    listener?.onLog("peer connection: ${newState?.name?.lowercase()}",
                        if (newState == PeerConnection.PeerConnectionState.CONNECTED) "ok" else null)
                    when (newState) {
                        PeerConnection.PeerConnectionState.CONNECTED -> listener?.onConnected()
                        PeerConnection.PeerConnectionState.FAILED -> listener?.onDisconnected("connection failed")
                        PeerConnection.PeerConnectionState.DISCONNECTED -> listener?.onDisconnected("disconnected")
                        else -> Unit
                    }
                }
            }
        }

        val conn = Rtc.factory.createPeerConnection(Rtc.rtcConfig(), observer) ?: run {
            listener?.onLog("could not create a peer connection", "warn")
            return
        }
        pc = conn

        conn.setRemoteDescription(Rtc.Sdp(onOk = {
            main.post { attachMicAndAnswer(conn) }
        }, onErr = { e ->
            main.post { listener?.onLog("offer rejected: $e", "warn") }
        }), Rtc.sdpFromJson(data))
    }

    private fun attachMicAndAnswer(conn: PeerConnection) {
        // The camera opens audio as sendrecv, so a single m-line carries both
        // directions. Slot our microphone into it before answering.
        val audioTx = conn.transceivers.firstOrNull { it.mediaType == org.webrtc.MediaStreamTrack.MediaType.MEDIA_TYPE_AUDIO }
        if (audioTx != null) {
            val mic = micTrack
            if (mic != null) {
                runCatching { audioTx.sender.setTrack(mic, false) }
                runCatching { audioTx.direction = RtpTransceiver.RtpTransceiverDirection.SEND_RECV }
            } else {
                runCatching { audioTx.direction = RtpTransceiver.RtpTransceiverDirection.RECV_ONLY }
            }
        }

        conn.createAnswer(Rtc.Sdp(onOk = { desc ->
            desc ?: return@Sdp
            conn.setLocalDescription(Rtc.Sdp(onOk = {
                signal.send("answer", Rtc.sdpToJson(desc))
                main.post {
                    listener?.onLog("answer sent", "ctrl")
                    pendingIce.forEach { conn.addIceCandidate(it) }
                    pendingIce.clear()
                }
            }), desc)
        }, onErr = { e ->
            main.post { listener?.onLog("answer failed: $e", "warn") }
        }), MediaConstraints())
    }

    fun onIce(data: JSONObject) {
        val c = Rtc.candidateFromJson(data) ?: return
        val conn = pc
        if (conn != null && conn.remoteDescription != null) conn.addIceCandidate(c) else pendingIce.add(c)
    }

    // ----------------------------------------------------------- commands ---

    fun send(json: JSONObject) {
        val channel = dc ?: return
        if (channel.state() != DataChannel.State.OPEN) return
        val bytes = json.toString().toByteArray(Charsets.UTF_8)
        channel.send(DataChannel.Buffer(ByteBuffer.wrap(bytes), false))
    }

    fun requestCapture() {
        send(JSONObject().put("cmd", "capture"))
        listener?.onLog("capture command sent over the data channel", "ctrl")
    }

    fun requestFlip() = send(JSONObject().put("cmd", "switch"))
    fun requestTorch(on: Boolean) = send(JSONObject().put("cmd", "torch").put("on", on))

    private fun onDeviceMessage(raw: String) {
        val msg = runCatching { JSONObject(raw) }.getOrNull() ?: return

        msg.optJSONObject("state")?.let { s ->
            listener?.onCameraState(
                s.optString("facing", "rear"),
                s.optInt("width"), s.optInt("height"),
                s.optInt("shots"), s.optBoolean("torchCapable")
            )
        }

        when (msg.optString("ack")) {
            "capture" -> listener?.onCaptureAck(
                msg.optBoolean("ok"),
                msg.optString("name").takeIf { it.isNotBlank() && it != "null" },
                msg.optInt("bytes")
            )
            "switch" -> listener?.onLog("camera flipped")
            "torch" -> listener?.onLog(
                "camera torch " + (if (msg.optBoolean("on")) "on" else "off") +
                        (if (msg.optBoolean("ok")) "" else " (unsupported)"),
                if (msg.optBoolean("ok")) null else "warn"
            )
        }
    }

    fun peerConnection(): PeerConnection? = pc

    fun release() {
        runCatching { dc?.close() }
        runCatching { pc?.close() }
        dc = null
        pc = null
        micTrack?.dispose()
        micSource?.dispose()
        micTrack = null
        micSource = null
        remoteVideo = null
        remoteAudio = null
    }
}
