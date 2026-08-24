package ai.less.p2pcam.net

import java.security.MessageDigest
import java.security.SecureRandom

/**
 * Pairing primitives. These must agree byte-for-byte with the browser client
 * (`public/assets/rtc.js`) and the server (`server.js`), or a PIN typed on one
 * will not open a session on the other.
 */
object Crypto {

    private val rng = SecureRandom()

    /** The proof handed to the server. The PIN itself never leaves the device. */
    fun pairHash(uid: String, pin: String): String {
        val md = MessageDigest.getInstance("SHA-256")
        val bytes = md.digest("${uid.uppercase()}:$pin".toByteArray(Charsets.UTF_8))
        return bytes.toHex()
    }

    /** Uniform in [0, bound). Rejection sampling keeps it unbiased. */
    fun randomBelow(bound: Int): Int {
        require(bound > 0)
        val limit = (Int.MAX_VALUE / bound) * bound
        while (true) {
            val v = rng.nextInt(Int.MAX_VALUE)
            if (v < limit) return v % bound
        }
    }

    /** Six-digit pairing PIN, shown on the device and typed into the viewer. */
    fun mintPin(): String = buildString { repeat(6) { append(randomBelow(10)) } }

    /**
     * A UID shaped like something burned into a real unit. Excludes I and O so
     * it survives being read aloud across a table.
     */
    fun mintUid(): String {
        val alpha = "ABCDEFGHJKLMNPQRSTUVWXYZ"
        val digits = buildString { repeat(6) { append(randomBelow(10)) } }
        val tail = buildString { repeat(3) { append(alpha[randomBelow(alpha.length)]) } }
        return "LESSAI-$digits-$tail"
    }

    fun randomId(): String {
        val b = ByteArray(16)
        rng.nextBytes(b)
        return b.toHex()
    }

    private fun ByteArray.toHex(): String {
        val out = StringBuilder(size * 2)
        for (x in this) {
            val i = x.toInt() and 0xFF
            if (i < 0x10) out.append('0')
            out.append(Integer.toHexString(i))
        }
        return out.toString()
    }
}
