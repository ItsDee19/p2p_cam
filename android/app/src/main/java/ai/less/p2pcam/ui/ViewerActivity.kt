package ai.less.p2pcam.ui

import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.Editable
import android.text.TextWatcher
import android.view.View
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import ai.less.p2pcam.R
import ai.less.p2pcam.databinding.ActivityViewerBinding
import ai.less.p2pcam.net.Crypto
import ai.less.p2pcam.net.Signal
import ai.less.p2pcam.rtc.Rtc
import ai.less.p2pcam.rtc.Snapshot
import ai.less.p2pcam.rtc.Stats
import ai.less.p2pcam.rtc.ViewerSession
import org.json.JSONObject
import org.webrtc.RendererCommon
import kotlin.concurrent.thread

/** This phone as the monitoring app. */
class ViewerActivity : AppCompatActivity() {

    private lateinit var b: ActivityViewerBinding

    private var signal: Signal? = null
    private var session: ViewerSession? = null

    private val main = Handler(Looper.getMainLooper())
    private var statsTick: Runnable? = null
    private var prev: Snapshot? = null

    private val server by lazy { intent.getStringExtra(HomeActivity.EXTRA_SERVER).orEmpty() }
    private val selfSigned by lazy { intent.getBooleanExtra(HomeActivity.EXTRA_SELF_SIGNED, false) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        b = ActivityViewerBinding.inflate(layoutInflater)
        setContentView(b.root)

        Rtc.init(this)

        b.feed.init(Rtc.egl.eglBaseContext, null)
        b.feed.setScalingType(RendererCommon.ScalingType.SCALE_ASPECT_FIT)
        b.feed.setEnableHardwareScaler(true)
        b.brackets.state = BracketFrame.State.IDLE

        val watcher = object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, a: Int, c: Int, d: Int) = Unit
            override fun onTextChanged(s: CharSequence?, a: Int, c: Int, d: Int) = Unit
            override fun afterTextChanged(s: Editable?) {
                clearPairError()      // typing is what dismisses a failure
                refreshPairState()
            }
        }
        b.uidInput.addTextChangedListener(watcher)
        b.pinInput.addTextChangedListener(watcher)

        b.btnConnect.setOnClickListener { connect() }
        b.btnDisconnect.setOnClickListener { disconnect("disconnected") }

        b.btnListen.setOnClickListener {
            val s = session ?: return@setOnClickListener
            s.listening = !s.listening
            b.btnListen.text = if (s.listening) "Mute" else "Listen"
            tint(b.btnListen, if (s.listening) R.color.ctrl else null)
            if (s.listening) log("listening — expect feedback if both devices are in one room", "warn")
        }

        b.btnTalk.setOnClickListener {
            val s = session ?: return@setOnClickListener
            s.talking = !s.talking
            b.btnTalk.text = if (s.talking) "Stop" else "Talk"
            tint(b.btnTalk, if (s.talking) R.color.accent else null)
            b.micPill.visibility = if (s.talking) View.VISIBLE else View.GONE
        }

        b.btnCapture.setOnClickListener { session?.requestCapture() }
        b.btnFlipRemote.setOnClickListener { session?.requestFlip() }

        refreshPairState()
    }

    // -------------------------------------------------------- pair state --

    private fun refreshPairState() {
        val uid = b.uidInput.text.toString().trim().uppercase()
        val pin = b.pinInput.text.toString().trim()
        b.pinCount.text = "${pin.length}/6"
        b.pinInput.setBackgroundResource(
            if (pin.length == 6) R.drawable.input_ok else R.drawable.input)
        b.pinInput.setTextColor(ContextCompat.getColor(this,
            if (pin.length == 6) R.color.ctrl else R.color.accent))
        b.btnConnect.isEnabled =
            Regex("^[A-Z0-9][A-Z0-9-]{2,39}$").matches(uid) && pin.length == 6 && signal == null
        // Deliberately does NOT clear pairError: this runs right after
        // showPairError() and used to erase the message before it was seen.
    }

    private fun clearPairError() { b.pairError.visibility = View.GONE }

    private fun showPairError(text: String) {
        b.pairError.text = text
        b.pairError.visibility = View.VISIBLE
    }

    // ----------------------------------------------------------- connect --

    private fun connect() {
        val uid = b.uidInput.text.toString().trim().uppercase()
        val pin = b.pinInput.text.toString().trim()
        if (pin.length != 6) return

        b.btnConnect.isEnabled = false
        b.brackets.state = BracketFrame.State.CONNECTING
        log("checking pairing…", "ctrl")

        val auth = Crypto.pairHash(uid, pin)
        val sig = Signal(server, uid, "viewer", auth, selfSigned)

        thread {
            val probe = sig.check()
            runOnUiThread {
                if (!probe.ok) {
                    showPairError(probe.error ?: "pairing refused")
                    log("pairing refused: ${probe.error}", "warn")
                    b.brackets.state = BracketFrame.State.IDLE
                    refreshPairState()
                    return@runOnUiThread
                }
                openStream(sig)
            }
        }
    }

    private fun openStream(sig: Signal) {
        signal = sig

        val s = ViewerSession(this, sig).also { session = it }
        s.prepareMic()
        s.attachRenderer(b.feed)

        s.listener = object : ViewerSession.Listener {
            override fun onLog(text: String, kind: String?) = log(text, kind)

            override fun onConnected() {
                b.emptyText.visibility = View.GONE
                b.livePill.visibility = View.VISIBLE
                b.statStrip.visibility = View.VISIBLE
                b.pairForm.visibility = View.GONE
                b.liveControls.visibility = View.VISIBLE
                b.brackets.state = BracketFrame.State.LIVE
                startStats()
            }

            override fun onDisconnected(reason: String) {
                b.brackets.state = BracketFrame.State.CONNECTING
                log("peer $reason", "warn")
            }

            override fun onControlReady(ready: Boolean) {
                b.btnCapture.isEnabled = ready
                b.btnFlipRemote.isEnabled = ready
            }

            override fun onCameraState(facing: String, width: Int, height: Int, shots: Int, torchCapable: Boolean) {
                log("camera: $facing · ${width}×${height}" + if (shots > 0) " · $shots saved" else "")
            }

            override fun onCaptureAck(ok: Boolean, name: String?, bytes: Int) {
                if (ok) log("saved on the camera: $name (${bytes / 1024} KB)", "ok")
                else log("camera could not capture a frame", "warn")
            }
        }

        sig.listener(object : Signal.Listener {
            override fun onReady(token: String) = log("paired — waiting for the offer", "ctrl")
            override fun onRoster(peers: List<Signal.Peer>) {
                if (peers.none { it.role == "camera" }) log("no camera online for that UID", "warn")
            }
            override fun onBye(from: String, peerRole: String) {
                if (peerRole == "camera") disconnect("camera went offline")
            }
            override fun onSignal(from: String, type: String, data: JSONObject) {
                when (type) {
                    "offer" -> session?.onOffer(data)
                    "ice" -> session?.onIce(data)
                }
            }
            override fun onDown(attempts: Int) = log("signalling lost — retrying", "warn")
            override fun onFailed(reason: String) {
                showPairError(reason)
                disconnect(reason)
            }
        })

        sig.connect()
    }

    // ------------------------------------------------------------- stats --

    private fun startStats() {
        stopStats()
        val tick = object : Runnable {
            override fun run() {
                val pc = session?.peerConnection()
                if (pc != null) {
                    Stats.read(pc, prev) { snap ->
                        prev = snap
                        runOnUiThread { render(snap) }
                    }
                }
                main.postDelayed(this, 1000)
            }
        }
        statsTick = tick
        main.post(tick)
    }

    private fun stopStats() {
        statsTick?.let { main.removeCallbacks(it) }
        statsTick = null
        prev = null
    }

    private fun render(s: Snapshot) {
        b.sRate.text = Stats.formatRate(s.kbps)
        b.sRes.text = if (s.width > 0) "${s.width}×${s.height}" else "—"
        b.sRtt.text = if (s.rttMs >= 0) "${s.rttMs} ms" else "—"

        b.pathPill.visibility = View.VISIBLE
        b.pathPill.text = s.path.label()
        val relayed = s.path == Snapshot.Path.RELAYED
        b.pathPill.setBackgroundResource(if (relayed) R.drawable.pill_muted else R.drawable.pill_ctrl)
        b.pathPill.setTextColor(ContextCompat.getColor(this, if (relayed) R.color.warn else R.color.ctrl))
    }

    // -------------------------------------------------------- disconnect --

    private fun disconnect(reason: String) {
        stopStats()
        session?.release()
        session = null
        signal?.close()
        signal = null

        b.feed.clearImage()
        b.emptyText.visibility = View.VISIBLE
        b.livePill.visibility = View.GONE
        b.micPill.visibility = View.GONE
        b.statStrip.visibility = View.GONE
        b.pathPill.visibility = View.GONE
        b.pairForm.visibility = View.VISIBLE
        b.liveControls.visibility = View.GONE
        b.brackets.state = BracketFrame.State.IDLE
        b.btnListen.text = "Listen"; tint(b.btnListen, null)
        b.btnTalk.text = "Talk"; tint(b.btnTalk, null)
        refreshPairState()
        log(reason)
    }

    private fun tint(btn: android.widget.Button, colorRes: Int?) {
        if (colorRes == null) {
            btn.setBackgroundResource(R.drawable.btn)
            btn.setTextColor(ContextCompat.getColor(this, R.color.ink2))
        } else {
            btn.setBackgroundResource(
                if (colorRes == R.color.accent) R.drawable.btn_accent else R.drawable.btn_ctrl)
            btn.setTextColor(ContextCompat.getColor(this,
                if (colorRes == R.color.accent) R.color.on_accent else R.color.on_ctrl))
        }
    }

    private fun log(text: String, kind: String? = null) {
        android.util.Log.i("P2PCam/Viewer", text)
        b.logLine.text = text
        b.logLine.setTextColor(ContextCompat.getColor(this, when (kind) {
            "warn" -> R.color.warn
            "ok" -> R.color.ok
            "ctrl" -> R.color.ctrl
            "media" -> R.color.accent
            else -> R.color.faint
        }))
    }

    override fun onDestroy() {
        stopStats()
        session?.release()
        signal?.close()
        runCatching { b.feed.release() }
        super.onDestroy()
    }
}
