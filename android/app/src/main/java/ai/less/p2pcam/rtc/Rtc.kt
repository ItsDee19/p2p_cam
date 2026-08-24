package ai.less.p2pcam.rtc

import android.content.Context
import org.json.JSONObject
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.EglBase
import org.webrtc.IceCandidate
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription

/**
 * Shared WebRTC plumbing.
 *
 * No ICE servers are configured. On one LAN, host candidates connect directly
 * and nothing outside the network is contacted — the same deliberate choice the
 * web prototype makes. Section 02 of the proposal describes the STUN and TURN
 * tier a real deployment adds for the internet case.
 */
object Rtc {

    lateinit var egl: EglBase
        private set

    lateinit var factory: PeerConnectionFactory
        private set

    private var started = false

    @Synchronized
    fun init(context: Context) {
        if (started) return
        started = true

        PeerConnectionFactory.initialize(
            PeerConnectionFactory.InitializationOptions.builder(context.applicationContext)
                .setEnableInternalTracer(false)
                .createInitializationOptions()
        )

        egl = EglBase.create()
        factory = PeerConnectionFactory.builder()
            .setVideoEncoderFactory(DefaultVideoEncoderFactory(egl.eglBaseContext, true, true))
            .setVideoDecoderFactory(DefaultVideoDecoderFactory(egl.eglBaseContext))
            .setOptions(PeerConnectionFactory.Options())
            .createPeerConnectionFactory()
    }

    fun rtcConfig(): PeerConnection.RTCConfiguration =
        PeerConnection.RTCConfiguration(emptyList()).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
            bundlePolicy = PeerConnection.BundlePolicy.MAXBUNDLE
            rtcpMuxPolicy = PeerConnection.RtcpMuxPolicy.REQUIRE
            continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY
        }

    // ------------------------------------------------------ JSON interop --
    // These shapes must match what the browser sends: RTCSessionDescription
    // serialises as {type, sdp} and RTCIceCandidate.toJSON() as
    // {candidate, sdpMid, sdpMLineIndex}.

    fun sdpToJson(sdp: SessionDescription): JSONObject =
        JSONObject()
            .put("type", sdp.type.canonicalForm())
            .put("sdp", sdp.description)

    fun sdpFromJson(json: JSONObject): SessionDescription {
        val type = SessionDescription.Type.fromCanonicalForm(json.optString("type", "offer"))
        return SessionDescription(type, json.optString("sdp"))
    }

    fun candidateToJson(c: IceCandidate): JSONObject =
        JSONObject()
            .put("candidate", c.sdp)
            .put("sdpMid", c.sdpMid)
            .put("sdpMLineIndex", c.sdpMLineIndex)

    fun candidateFromJson(json: JSONObject): IceCandidate? {
        val sdp = json.optString("candidate")
        if (sdp.isNullOrBlank()) return null
        return IceCandidate(
            json.optString("sdpMid", "0"),
            json.optInt("sdpMLineIndex", 0),
            sdp
        )
    }

    /** SdpObserver is four methods where we only ever care about two. */
    open class Sdp(
        private val onOk: (SessionDescription?) -> Unit = {},
        private val onErr: (String) -> Unit = {},
    ) : SdpObserver {
        override fun onCreateSuccess(desc: SessionDescription?) = onOk(desc)
        override fun onSetSuccess() = onOk(null)
        override fun onCreateFailure(err: String?) = onErr(err.orEmpty())
        override fun onSetFailure(err: String?) = onErr(err.orEmpty())
    }

    /** PeerConnection.Observer with everything defaulted to a no-op. */
    open class Obs : PeerConnection.Observer {
        override fun onSignalingChange(s: PeerConnection.SignalingState?) = Unit
        override fun onIceConnectionChange(s: PeerConnection.IceConnectionState?) = Unit
        override fun onIceConnectionReceivingChange(receiving: Boolean) = Unit
        override fun onIceGatheringChange(s: PeerConnection.IceGatheringState?) = Unit
        override fun onIceCandidate(candidate: IceCandidate?) = Unit
        override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>?) = Unit
        override fun onAddStream(stream: org.webrtc.MediaStream?) = Unit
        override fun onRemoveStream(stream: org.webrtc.MediaStream?) = Unit
        override fun onDataChannel(dc: org.webrtc.DataChannel?) = Unit
        override fun onRenegotiationNeeded() = Unit
        override fun onAddTrack(receiver: org.webrtc.RtpReceiver?, streams: Array<out org.webrtc.MediaStream>?) = Unit
        override fun onTrack(transceiver: org.webrtc.RtpTransceiver?) = Unit
        override fun onConnectionChange(newState: PeerConnection.PeerConnectionState?) = Unit
    }
}
