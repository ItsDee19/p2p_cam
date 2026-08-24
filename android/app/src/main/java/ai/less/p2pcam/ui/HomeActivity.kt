package ai.less.p2pcam.ui

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import ai.less.p2pcam.databinding.ActivityHomeBinding
import ai.less.p2pcam.rtc.Rtc

class HomeActivity : AppCompatActivity() {

    private lateinit var b: ActivityHomeBinding
    private var pendingRole: String? = null

    private val permissions = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { granted ->
        val role = pendingRole
        pendingRole = null
        if (role == null) return@registerForActivityResult

        val needed = requiredFor(role)
        if (needed.all { granted[it] == true }) {
            launch(role)
        } else {
            b.statusLine.text = "camera and microphone permission are required"
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        b = ActivityHomeBinding.inflate(layoutInflater)
        setContentView(b.root)

        Rtc.init(this)

        val prefs = getSharedPreferences(PREFS, MODE_PRIVATE)
        b.serverInput.setText(prefs.getString(KEY_SERVER, "") ?: "")
        b.selfSigned.isChecked = prefs.getBoolean(KEY_SELF_SIGNED, false)

        b.roleCamera.setOnClickListener { request("camera") }
        b.roleViewer.setOnClickListener { request("viewer") }
    }

    private fun requiredFor(role: String): Array<String> =
        if (role == "camera") arrayOf(Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO)
        else arrayOf(Manifest.permission.RECORD_AUDIO)   // talk-back

    private fun request(role: String) {
        val server = normalise(b.serverInput.text?.toString().orEmpty())
        if (server == null) {
            b.statusLine.text = "enter the server address, e.g. http://192.168.0.10:8099"
            return
        }
        b.statusLine.text = ""

        getSharedPreferences(PREFS, MODE_PRIVATE).edit()
            .putString(KEY_SERVER, server)
            .putBoolean(KEY_SELF_SIGNED, b.selfSigned.isChecked)
            .apply()

        val needed = requiredFor(role)
        val missing = needed.any {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }
        if (missing) {
            pendingRole = role
            permissions.launch(needed)
        } else {
            launch(role)
        }
    }

    private fun launch(role: String) {
        val server = normalise(b.serverInput.text?.toString().orEmpty()) ?: return
        val cls = if (role == "camera") CameraActivity::class.java else ViewerActivity::class.java
        startActivity(Intent(this, cls).apply {
            putExtra(EXTRA_SERVER, server)
            putExtra(EXTRA_SELF_SIGNED, b.selfSigned.isChecked)
        })
    }

    /** Accepts "192.168.0.10:8099" as well as a full URL, and trims a trailing slash. */
    private fun normalise(raw: String): String? {
        var s = raw.trim()
        if (s.isEmpty()) return null
        if (!s.startsWith("http://") && !s.startsWith("https://")) s = "http://$s"
        s = s.trimEnd('/')
        return runCatching {
            val u = java.net.URL(s)
            if (u.host.isNullOrBlank()) null else s
        }.getOrNull()
    }

    companion object {
        const val PREFS = "p2pcam"
        const val KEY_SERVER = "server"
        const val KEY_SELF_SIGNED = "selfSigned"
        const val EXTRA_SERVER = "server"
        const val EXTRA_SELF_SIGNED = "selfSigned"
    }
}
