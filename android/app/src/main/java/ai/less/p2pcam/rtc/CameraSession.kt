package ai.less.p2pcam.rtc

import android.content.Context
import android.os.Handler
import android.os.Looper
import ai.less.p2pcam.net.Signal
import org.json.JSONObject
import org.webrtc.AudioTrack
import org.webrtc.Camera2Enumerator
import org.webrtc.CameraVideoCapturer
import org.webrtc.DataChannel
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.PeerConnection
import org.webrtc.RtpTransceiver
import org.webrtc.SessionDescription
import org.webrtc.SurfaceTextureHelper
import org.webrtc.SurfaceViewRenderer
import org.webrtc.VideoSink
import org.webrtc.VideoTrack
import java.nio.ByteBuffer

/**
 * This device acting as the camera: captures locally, offers to every viewer
 * that pairs, and serves remote commands over the data channel.
 */
class CameraSession(
    private val context: Context,
    private val uid: String,
    private val signal: Signal,
) {

    interface Listener {
        fun onLog(text: String, kind: String? = null)
        fun onViewers(count: Int)
        fun onCaptureSaved(saved: FrameCapture.Saved)
        fun onFacingChanged(front: Boolean)
        fun onTorchAvailable(available: Boolean)
    }

    private class Peer(
        val pc: PeerConnection,
        var dc: DataChannel? = null,
        val pendingIce: MutableList<IceCandidate> = mutableListOf(),
    )

    private val main = Handler(Looper.getMainLooper())
    private val peers = LinkedHashMap<String, Peer>()

    private var capturer: CameraVideoCapturer? = null
    private var helper: SurfaceTextureHelper? = null
    private var videoTrack: VideoTrack? = null
    private var audioTrack: AudioTrack? = null
    private var videoSource: org.webrtc.VideoSource? = null

    private var front = false
    private var torchOn = false
    private var shots = 0

    var listener: Listener? = null
    var speakerOn = true

    /** One-shot frame grab, serviced by the sink below. */
    private var pendingCapture: ((FrameCapture.Saved?) -> Unit)? = null

    private val captureSink = VideoSink { frame ->
        val cb = pendingCapture ?: return@VideoSink
        pendingCapture = null
        val encoded = FrameCapture.encode(frame)
        if (encoded == null) {
            main.post { cb(null) }
        } else {
            val saved = runCatching { FrameCapture.save(context, uid, encoded.first) }.getOrNull()
            main.post { cb(saved) }
        }
    }

    // ------------------------------------------------------------- capture --

    fun start(renderer: SurfaceViewRenderer, preferFront: Boolean = false): Boolean {
        front = preferFront
        val enumerator = Camera2Enumerator(context)
        val name = pickCamera(enumerator, front) ?: run {
            listener?.onLog("no camera found on this device", "warn")
            return false
        }

        val cap = enumerator.createCapturer(name, object : CameraVideoCapturer.CameraEventsHandler {
            override fun onCameraError(err: String?) { main.post { listener?.onLog("camera error: $err", "warn") } }
            override fun onCameraDisconnected() = Unit
            override fun onCameraFreezed(err: String?) = Unit
            override fun onCameraOpening(name: String?) = Unit
            override fun onFirstFrameAvailable() = Unit
            override fun onCameraClosed() = Unit
        }) ?: return false

        capturer = cap
        helper = SurfaceTextureHelper.create("CaptureThread", Rtc.egl.eglBaseContext)
        videoSource = Rtc.factory.createVideoSource(false)
        cap.initialize(helper, context, videoSource!!.capturerObserver)
        cap.startCapture(1280, 720, 30)

        videoTrack = Rtc.factory.createVideoTrack(VIDEO_ID, videoSource).apply {
            addSink(renderer)
            addSink(captureSink)
        }

        val audioSource = Rtc.factory.createAudioSource(MediaConstraints())
        audioTrack = Rtc.factory.createAudioTrack(AUDIO_ID, audioSource)

        listener?.onFacingChanged(front)
        listener?.onTorchAvailable(!front)
        listener?.onLog("camera opened", "ok")
        return true
    }

    private fun pickCamera(e: Camera2Enumerator, wantFront: Boolean): String? {
        val names = e.deviceNames
        return names.firstOrNull { if (wantFront) e.isFrontFacing(it) else e.isBackFacing(it) }
            ?: names.firstOrNull()
    }

    fun switchCamera() {
        capturer?.switchCamera(object : CameraVideoCapturer.CameraSwitchHandler {
            override fun onCameraSwitchDone(isFront: Boolean) {
                main.post {
                    front = isFront
                    torchOn = false
                    listener?.onFacingChanged(isFront)
                    listener?.onTorchAvailable(!isFront)
                    listener?.onLog("flipped to ${if (isFront) "front" else "rear"} camera")
                    broadcastState()
                }
            }
            override fun onCameraSwitchError(err: String?) {
                main.post { listener?.onLog("flip failed: $err", "warn") }
            }
        })
    }

    /**
     * Torch is not exposed by the WebRTC capturer API, so this is reported as
     * unsupported rather than silently doing nothing. Driving it needs a direct
     * Camera2 handle, which is Phase 1 work on real firmware anyway.
     */
    fun setTorch(on: Boolean): Boolean {
        listener?.onLog("torch is not available through the WebRTC capturer", "warn")
        return false
    }

    fun capture(then: (FrameCapture.Saved?) -> Unit) {
        pendingCapture = { saved ->
            if (saved != null) {
                shots += 1
                listener?.onCaptureSaved(saved)
                listener?.onLog("still saved to this device: ${saved.name}", "ok")
            } else {
                listener?.onLog("could not capture a frame", "warn")
            }
            then(saved)
        }
    }

    // ------------------------------------------------------------ peers ----

    fun offerTo(viewerId: String) {
        peers.remove(viewerId)?.let { runCatching { it.pc.close() } }

        val observer = object : Rtc.Obs() {
            override fun onIceCandidate(candidate: IceCandidate?) {
                candidate ?: return
                signal.send("ice", Rtc.candidateToJson(candidate), viewerId)
            }

            override fun onConnectionChange(newState: PeerConnection.PeerConnectionState?) {
                main.post {
                    listener?.onLog("peer ${viewerId.take(8)}: ${newState?.name?.lowercase()}",
                        if (newState == PeerConnection.PeerConnectionState.CONNECTED) "ok" else null)
                    if (newState == PeerConnection.PeerConnectionState.FAILED ||
                        newState == PeerConnection.PeerConnectionState.CLOSED
                    ) {
                        peers.remove(viewerId)?.let { runCatching { it.pc.close() } }
                    }
                    listener?.onViewers(peers.size)
                }
            }

            override fun onTrack(transceiver: RtpTransceiver?) {
                // The viewer's talk-back audio plays through the device speaker
                // automatically; nothing to wire up here.
                if (transceiver?.receiver?.track()?.kind() == "audio") {
                    main.post { listener?.onLog("talk-back audio track received", "media") }
                }
            }
        }

        val pc = Rtc.factory.createPeerConnection(Rtc.rtcConfig(), observer) ?: return
        val peer = Peer(pc)
        peers[viewerId] = peer

        videoTrack?.let {
            pc.addTransceiver(it, RtpTransceiver.RtpTransceiverInit(
                RtpTransceiver.RtpTransceiverDirection.SEND_ONLY, listOf(STREAM_ID)))
        }
        audioTrack?.let {
            pc.addTransceiver(it, RtpTransceiver.RtpTransceiverInit(
                RtpTransceiver.RtpTransceiverDirection.SEND_RECV, listOf(STREAM_ID)))
        }

        val dc = pc.createDataChannel("ctl", DataChannel.Init().apply { ordered = true })
        peer.dc = dc
        dc?.registerObserver(object : DataChannel.Observer {
            override fun onBufferedAmountChange(amount: Long) = Unit
            override fun onStateChange() {
                if (dc.state() == DataChannel.State.OPEN) {
                    main.post {
                        listener?.onLog("control channel open to ${viewerId.take(8)}", "ok")
                        sendState(dc)
                    }
                }
            }
            override fun onMessage(buffer: DataChannel.Buffer?) {
                val data = buffer?.data ?: return
                val bytes = ByteArray(data.remaining())
                data.get(bytes)
                val text = String(bytes, Charsets.UTF_8)
                main.post { onCommand(text, dc) }
            }
        })

        pc.createOffer(Rtc.Sdp(onOk = { desc ->
            desc ?: return@Sdp
            pc.setLocalDescription(Rtc.Sdp(onOk = {
                signal.send("offer", Rtc.sdpToJson(desc), viewerId)
                main.post { listener?.onLog("offer sent to ${viewerId.take(8)}", "ctrl") }
            }), desc)
        }, onErr = { e ->
            main.post { listener?.onLog("offer failed: $e", "warn") }
        }), MediaConstraints())

        listener?.onViewers(peers.size)
    }

    fun onAnswer(from: String, data: JSONObject) {
        val peer = peers[from] ?: return
        peer.pc.setRemoteDescription(Rtc.Sdp(onOk = {
            main.post {
                listener?.onLog("answer accepted from ${from.take(8)}", "ctrl")
                peer.pendingIce.forEach { peer.pc.addIceCandidate(it) }
                peer.pendingIce.clear()
            }
        }, onErr = { e ->
            main.post { listener?.onLog("answer rejected: $e", "warn") }
        }), Rtc.sdpFromJson(data))
    }

    fun onIce(from: String, data: JSONObject) {
        val peer = peers[from] ?: return
        val c = Rtc.candidateFromJson(data) ?: return
        if (peer.pc.remoteDescription != null) peer.pc.addIceCandidate(c) else peer.pendingIce.add(c)
    }

    fun dropViewer(id: String) {
        peers.remove(id)?.let { runCatching { it.pc.close() } }
        listener?.onViewers(peers.size)
    }

    fun viewerCount() = peers.size

    // ---------------------------------------------------------- commands ----

    private fun onCommand(raw: String, dc: DataChannel) {
        val msg = runCatching { JSONObject(raw) }.getOrNull() ?: return
        when (msg.optString("cmd")) {
            "capture" -> {
                listener?.onLog("remote capture requested by the app", "ctrl")
                capture { saved ->
                    val ack = JSONObject()
                        .put("ack", "capture")
                        .put("ok", saved != null)
                        .put("name", saved?.name ?: JSONObject.NULL)
                        .put("bytes", saved?.bytes ?: 0)
                    sendJson(dc, ack)
                    broadcastState()
                }
            }
            "switch" -> {
                switchCamera()
                sendJson(dc, JSONObject().put("ack", "switch").put("ok", true))
            }
            "torch" -> {
                val ok = setTorch(msg.optBoolean("on"))
                sendJson(dc, JSONObject().put("ack", "torch").put("ok", ok).put("on", torchOn))
            }
            "state" -> sendState(dc)
        }
    }

    private fun sendState(dc: DataChannel?) {
        dc ?: return
        val state = JSONObject()
            .put("facing", if (front) "front" else "rear")
            .put("width", 1280).put("height", 720)
            .put("torch", torchOn)
            .put("torchCapable", false)
            .put("shots", shots)
        sendJson(dc, JSONObject().put("state", state))
    }

    private fun broadcastState() = peers.values.forEach { sendState(it.dc) }

    private fun sendJson(dc: DataChannel?, json: JSONObject) {
        dc ?: return
        if (dc.state() != DataChannel.State.OPEN) return
        val bytes = json.toString().toByteArray(Charsets.UTF_8)
        dc.send(DataChannel.Buffer(ByteBuffer.wrap(bytes), false))
    }

    // ------------------------------------------------------------ teardown --

    fun release() {
        peers.values.forEach { runCatching { it.pc.close() } }
        peers.clear()
        runCatching { capturer?.stopCapture() }
        capturer?.dispose()
        helper?.dispose()
        videoTrack?.dispose()
        audioTrack?.dispose()
        videoSource?.dispose()
        capturer = null; helper = null; videoTrack = null; audioTrack = null; videoSource = null
    }

    companion object {
        private const val VIDEO_ID = "v0"
        private const val AUDIO_ID = "a0"
        private const val STREAM_ID = "s0"
    }
}
