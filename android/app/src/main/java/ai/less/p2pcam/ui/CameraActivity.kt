package ai.less.p2pcam.ui

import android.os.Bundle
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import ai.less.p2pcam.R
import ai.less.p2pcam.databinding.ActivityCameraBinding
import ai.less.p2pcam.net.Crypto
import ai.less.p2pcam.net.Signal
import ai.less.p2pcam.rtc.CameraSession
import ai.less.p2pcam.rtc.CaptureService
import ai.less.p2pcam.rtc.FrameCapture
import ai.less.p2pcam.rtc.Rtc
import org.json.JSONObject
import org.webrtc.RendererCommon
import kotlin.concurrent.thread

/** This phone as the camera: publishes under a UID and a per-session PIN. */
class CameraActivity : AppCompatActivity() {

    private lateinit var b: ActivityCameraBinding

    private var signal: Signal? = null
    private var session: CameraSession? = null

    private lateinit var uid: String
    private var pin: String? = null
    private var running = false
    private var shots = 0

    private val server by lazy { intent.getStringExtra(HomeActivity.EXTRA_SERVER).orEmpty() }
    private val selfSigned by lazy { intent.getBooleanExtra(HomeActivity.EXTRA_SELF_SIGNED, false) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        b = ActivityCameraBinding.inflate(layoutInflater)
        setContentView(b.root)

        Rtc.init(this)

        uid = getSharedPreferences(HomeActivity.PREFS, MODE_PRIVATE)
            .getString(KEY_UID, null)
            ?.takeIf { Regex("^LESSAI-\\d{6}-[A-Z]{3}$").matches(it) }
            ?: Crypto.mintUid().also {
                getSharedPreferences(HomeActivity.PREFS, MODE_PRIVATE)
                    .edit().putString(KEY_UID, it).apply()
            }
        b.uidText.text = uid

        b.preview.init(Rtc.egl.eglBaseContext, null)
        b.preview.setScalingType(RendererCommon.ScalingType.SCALE_ASPECT_FILL)
        b.preview.setEnableHardwareScaler(true)

        b.brackets.state = BracketFrame.State.IDLE

        b.btnStart.setOnClickListener { if (running) stop() else start() }
        b.btnFlip.setOnClickListener { session?.switchCamera() }
        b.btnShot.setOnClickListener { session?.capture { } }
    }

    // ------------------------------------------------------------- start --

    private fun start() {
        pin = Crypto.mintPin()
        b.pinText.text = pin
        b.pinBlock.visibility = android.view.View.VISIBLE

        val auth = Crypto.pairHash(uid, pin!!)
        val sig = Signal(server, uid, "camera", auth, selfSigned)
        signal = sig

        val cam = CameraSession(this, uid, sig)
        session = cam
        cam.listener = object : CameraSession.Listener {
            override fun onLog(text: String, kind: String?) = log(text, kind)
            override fun onViewers(count: Int) {
                b.viewerPill.text = if (count == 1) "1 viewer" else "$count viewers"
                b.viewerPill.setBackgroundResource(
                    if (count > 0) R.drawable.pill_ctrl else R.drawable.pill_muted)
                b.viewerPill.setTextColor(
                    ContextCompat.getColor(this@CameraActivity, if (count > 0) R.color.ctrl else R.color.muted))
                b.brackets.state = if (count > 0) BracketFrame.State.LIVE else BracketFrame.State.CONNECTING
            }
            override fun onCaptureSaved(saved: FrameCapture.Saved) {
                shots += 1
                b.shotPill.visibility = android.view.View.VISIBLE
                b.shotPill.text = "$shots saved"
            }
            override fun onFacingChanged(front: Boolean) {
                b.preview.setMirror(front)
            }
            override fun onTorchAvailable(available: Boolean) = Unit
        }

        if (!cam.start(b.preview, preferFront = false)) {
            log("could not open the camera", "warn")
            return
        }

        sig.listener(object : Signal.Listener {
            override fun onReady(token: String) {
                log("registered $uid — PIN $pin", "ctrl")
                b.brackets.state = BracketFrame.State.CONNECTING
            }
            override fun onHello(from: String, peerRole: String) {
                if (peerRole != "viewer") return
                log("viewer ${from.take(8)} joined — sending offer", "ctrl")
                cam.offerTo(from)
            }
            override fun onRoster(peers: List<Signal.Peer>) {
                // A viewer already present when we (re)joined gets no hello.
                peers.filter { it.role == "viewer" && it.id != sig.clientId }
                    .forEach { if (cam.viewerCount() == 0) cam.offerTo(it.id) }
            }
            override fun onBye(from: String, peerRole: String) {
                cam.dropViewer(from)
                log("viewer ${from.take(8)} left")
            }
            override fun onSignal(from: String, type: String, data: JSONObject) {
                when (type) {
                    "answer" -> cam.onAnswer(from, data)
                    "ice" -> cam.onIce(from, data)
                }
            }
            override fun onDown(attempts: Int) = log("signalling lost — retrying", "warn")
            override fun onFailed(reason: String) {
                // Pass it through stop() or the "camera stopped" line erases it.
                stop("registration failed: $reason")
            }
        })

        thread {
            val probe = sig.check()
            runOnUiThread {
                // 404 is expected here: the room does not exist until we make it.
                if (!probe.ok && probe.status != 404) {
                    log("server refused: ${probe.error}", "warn")
                }
                sig.connect()
            }
        }

        // Android revokes camera and microphone from background apps; this
        // keeps them while the user is elsewhere.
        CaptureService.start(this, uid)

        running = true
        b.btnStart.text = "Stop"
        b.btnStart.setBackgroundResource(R.drawable.btn_accent)
        b.btnStart.setTextColor(ContextCompat.getColor(this, R.color.on_accent))
        b.btnFlip.isEnabled = true
        b.btnShot.isEnabled = true
        b.livePill.visibility = android.view.View.VISIBLE
        b.brackets.state = BracketFrame.State.CONNECTING
    }

    private fun stop(reason: String = "camera stopped") {
        running = false
        CaptureService.stop(this)
        session?.release()
        session = null
        signal?.close()
        signal = null
        pin = null

        b.pinBlock.visibility = android.view.View.GONE
        b.livePill.visibility = android.view.View.GONE
        b.shotPill.visibility = android.view.View.GONE
        b.btnStart.text = "Start"
        b.btnStart.setBackgroundResource(R.drawable.btn_ctrl)
        b.btnStart.setTextColor(ContextCompat.getColor(this, R.color.on_ctrl))
        b.btnFlip.isEnabled = false
        b.btnShot.isEnabled = false
        b.viewerPill.text = "0 viewers"
        b.brackets.state = BracketFrame.State.IDLE
        log(reason, if (reason == "camera stopped") null else "warn")
    }

    private fun log(text: String, kind: String? = null) {
        android.util.Log.i("P2PCam/Camera", text)
        b.logLine.text = text
        b.logLine.setTextColor(
            ContextCompat.getColor(this, when (kind) {
                "warn" -> R.color.warn
                "ok" -> R.color.ok
                "ctrl" -> R.color.ctrl
                "media" -> R.color.accent
                else -> R.color.faint
            })
        )
    }

    override fun onDestroy() {
        CaptureService.stop(this)
        session?.release()
        signal?.close()
        runCatching { b.preview.release() }
        super.onDestroy()
    }

    companion object {
        private const val KEY_UID = "deviceUid"
    }
}
