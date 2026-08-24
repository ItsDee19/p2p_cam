package ai.less.p2pcam.net

import android.os.Handler
import android.os.Looper
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.sse.EventSource
import okhttp3.sse.EventSourceListener
import okhttp3.sse.EventSources
import org.json.JSONObject
import java.util.concurrent.TimeUnit
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager

/**
 * Signalling transport: Server-Sent Events down, POST up. Carries offer,
 * answer and ICE only — never media.
 *
 * Two secrets are in play, mirroring the browser client:
 *   - the pairing proof, sha256(uid + ':' + PIN), which authorises joining
 *   - a per-connection bearer token, delivered only on this peer's own event
 *     stream, which must accompany every POST
 */
class Signal(
    private val baseUrl: String,
    private val uid: String,
    private val role: String,
    private val auth: String,
    allowSelfSigned: Boolean,
) {

    interface Listener {
        fun onReady(token: String) {}
        fun onHello(from: String, peerRole: String) {}
        fun onBye(from: String, peerRole: String) {}
        fun onRoster(peers: List<Peer>) {}
        fun onSignal(from: String, type: String, data: JSONObject) {}
        fun onDown(attempts: Int) {}
        fun onFailed(reason: String) {}
    }

    data class Peer(val id: String, val role: String)

    val clientId: String = Crypto.randomId()
    var token: String? = null
        private set

    private val main = Handler(Looper.getMainLooper())
    private val client = buildClient(allowSelfSigned)
    private var source: EventSource? = null
    private var failures = 0
    private var closed = false
    private var listener: Listener? = null

    fun listener(l: Listener) = apply { listener = l }

    // ---------------------------------------------------------------- probe --

    data class CheckResult(val ok: Boolean, val status: Int, val error: String?)

    /**
     * Side-effect-free pairing probe. SSE surfaces no status code, so we ask
     * first and can report "wrong PIN" instead of retrying against a 403.
     * Blocking — call from a background thread.
     */
    fun check(): CheckResult {
        val url = "$baseUrl/api/check?uid=${enc(uid)}&auth=${enc(auth)}"
        return try {
            client.newCall(Request.Builder().url(url).get().build()).execute().use { res ->
                val body = res.body?.string().orEmpty()
                if (res.isSuccessful) {
                    CheckResult(true, res.code, null)
                } else {
                    val msg = runCatching { JSONObject(body).optString("error") }.getOrNull()
                    CheckResult(false, res.code, msg?.takeIf { it.isNotBlank() } ?: "HTTP ${res.code}")
                }
            }
        } catch (e: Exception) {
            CheckResult(false, 0, "cannot reach the server (${e.message})")
        }
    }

    // --------------------------------------------------------------- stream --

    fun connect() {
        val url = "$baseUrl/api/events?uid=${enc(uid)}&role=${enc(role)}" +
                "&id=${enc(clientId)}&auth=${enc(auth)}"
        val req = Request.Builder().url(url).header("Accept", "text/event-stream").get().build()

        source = EventSources.createFactory(client).newEventSource(req, object : EventSourceListener() {
            override fun onOpen(eventSource: EventSource, response: okhttp3.Response) {
                failures = 0
            }

            override fun onEvent(eventSource: EventSource, id: String?, type: String?, data: String) {
                val json = runCatching { JSONObject(data) }.getOrNull() ?: return
                main.post { dispatch(type.orEmpty(), json) }
            }

            override fun onFailure(eventSource: EventSource, t: Throwable?, response: okhttp3.Response?) {
                if (closed) return
                failures += 1
                val code = response?.code ?: 0
                // A 4xx will never succeed on retry; do not sit in a loop that
                // is really a PIN-guessing machine.
                val fatal = code in 400..499 || failures >= 4
                main.post {
                    if (fatal) {
                        close()
                        listener?.onFailed(
                            when (code) {
                                403 -> "wrong PIN"
                                404 -> "no camera online with that UID"
                                409 -> "that UID is already claimed"
                                429 -> "too many attempts, wait a minute"
                                else -> t?.message ?: "signalling connection failed"
                            }
                        )
                    } else {
                        listener?.onDown(failures)
                    }
                }
            }
        })
    }

    private fun dispatch(type: String, json: JSONObject) {
        when (type) {
            "ready" -> {
                token = json.optString("token").takeIf { it.isNotBlank() }
                failures = 0
                token?.let { listener?.onReady(it) }
            }
            "hello" -> listener?.onHello(json.optString("from"), json.optString("role"))
            "bye" -> listener?.onBye(json.optString("from"), json.optString("role"))
            "roster" -> {
                val arr = json.optJSONArray("peers") ?: return
                val list = ArrayList<Peer>(arr.length())
                for (i in 0 until arr.length()) {
                    val p = arr.optJSONObject(i) ?: continue
                    list.add(Peer(p.optString("id"), p.optString("role")))
                }
                listener?.onRoster(list)
            }
            "signal" -> listener?.onSignal(
                json.optString("from"),
                json.optString("type"),
                json.optJSONObject("data") ?: JSONObject()
            )
        }
    }

    // ----------------------------------------------------------------- send --

    /** Fire-and-forget; the relay's acknowledgement carries nothing we need. */
    fun send(type: String, data: JSONObject, to: String? = null) {
        val tok = token ?: return
        val body = JSONObject()
            .put("uid", uid)
            .put("from", clientId)
            .put("token", tok)
            .put("to", to ?: JSONObject.NULL)
            .put("type", type)
            .put("data", data)
            .toString()

        val req = Request.Builder()
            .url("$baseUrl/api/signal")
            .post(body.toRequestBody(JSON))
            .build()

        client.newCall(req).enqueue(object : okhttp3.Callback {
            override fun onFailure(call: okhttp3.Call, e: java.io.IOException) = Unit
            override fun onResponse(call: okhttp3.Call, response: okhttp3.Response) { response.close() }
        })
    }

    fun close() {
        closed = true
        source?.cancel()
        source = null
    }

    // -------------------------------------------------------------- plumbing --

    private fun enc(s: String): String = java.net.URLEncoder.encode(s, "UTF-8")

    companion object {
        private val JSON = "application/json; charset=utf-8".toMediaType()

        /**
         * Prototype-only: when the operator opts in, accept the demo server's
         * self-signed certificate. This disables certificate validation for
         * this client and must never ship. Plain HTTP on the LAN is the
         * preferred path and needs none of this.
         */
        private fun buildClient(allowSelfSigned: Boolean): OkHttpClient {
            val b = OkHttpClient.Builder()
                .readTimeout(0, TimeUnit.MILLISECONDS)     // SSE stays open
                .connectTimeout(10, TimeUnit.SECONDS)
                .writeTimeout(15, TimeUnit.SECONDS)
                .retryOnConnectionFailure(true)
                .pingInterval(20, TimeUnit.SECONDS)

            if (allowSelfSigned) {
                val trustAll = object : X509TrustManager {
                    override fun checkClientTrusted(c: Array<out java.security.cert.X509Certificate>?, a: String?) = Unit
                    override fun checkServerTrusted(c: Array<out java.security.cert.X509Certificate>?, a: String?) = Unit
                    override fun getAcceptedIssuers(): Array<java.security.cert.X509Certificate> = arrayOf()
                }
                val ctx = SSLContext.getInstance("TLS")
                ctx.init(null, arrayOf<javax.net.ssl.TrustManager>(trustAll), java.security.SecureRandom())
                b.sslSocketFactory(ctx.socketFactory, trustAll)
                b.hostnameVerifier(HostnameVerifier { _, _ -> true })
            }
            return b.build()
        }
    }
}
