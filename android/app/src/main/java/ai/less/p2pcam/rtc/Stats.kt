package ai.less.p2pcam.rtc

import org.webrtc.PeerConnection
import org.webrtc.RTCStatsReport
import java.math.BigInteger

/**
 * Flattens getStats() into the handful of numbers the UI shows, and works out
 * whether the connection is direct or relayed — the reading that matters most
 * in a demo.
 */
data class Snapshot(
    val atMs: Long = 0,
    val bytes: Long = 0,
    val kbps: Double = 0.0,
    val width: Int = 0,
    val height: Int = 0,
    val fps: Int = 0,
    val packetsLost: Int = 0,
    val rttMs: Int = -1,
    val path: Path = Path.UNKNOWN,
) {
    enum class Path { UNKNOWN, DIRECT_LAN, DIRECT, RELAYED;

        fun label(): String = when (this) {
            DIRECT_LAN -> "DIRECT · LAN"
            DIRECT -> "DIRECT · P2P"
            RELAYED -> "RELAYED"
            UNKNOWN -> "CONNECTING"
        }
    }
}

object Stats {

    fun read(pc: PeerConnection, prev: Snapshot?, onResult: (Snapshot) -> Unit) {
        pc.getStats { report: RTCStatsReport ->
            onResult(parse(report, prev))
        }
    }

    private fun parse(report: RTCStatsReport, prev: Snapshot?): Snapshot {
        var bytes = 0L
        var width = 0
        var height = 0
        var fps = 0
        var lost = 0
        var rtt = -1
        var localType: String? = null
        var remoteType: String? = null

        var bestPairLocal: String? = null
        var bestPairRemote: String? = null
        var bestNominated = false
        val candidateTypes = HashMap<String, String>()

        for (s in report.statsMap.values) {
            val m = s.members
            when (s.type) {
                "inbound-rtp" -> {
                    if (m["kind"] as? String == "video") {
                        bytes = num(m["bytesReceived"])
                        width = num(m["frameWidth"]).toInt()
                        height = num(m["frameHeight"]).toInt()
                        fps = (m["framesPerSecond"] as? Double)?.toInt() ?: 0
                        lost = num(m["packetsLost"]).toInt()
                    }
                }
                "candidate-pair" -> {
                    val nominated = m["nominated"] as? Boolean ?: false
                    val state = m["state"] as? String
                    if (nominated || state == "succeeded") {
                        if (nominated || !bestNominated) {
                            bestNominated = bestNominated || nominated
                            bestPairLocal = m["localCandidateId"] as? String
                            bestPairRemote = m["remoteCandidateId"] as? String
                            (m["currentRoundTripTime"] as? Double)?.let { rtt = (it * 1000).toInt() }
                        }
                    }
                }
                "local-candidate", "remote-candidate" -> {
                    (m["candidateType"] as? String)?.let { candidateTypes[s.id] = it }
                }
            }
        }

        localType = bestPairLocal?.let { candidateTypes[it] }
        remoteType = bestPairRemote?.let { candidateTypes[it] }

        val path = when {
            localType == "relay" || remoteType == "relay" -> Snapshot.Path.RELAYED
            localType == "host" && remoteType == "host" -> Snapshot.Path.DIRECT_LAN
            localType != null || remoteType != null -> Snapshot.Path.DIRECT
            else -> Snapshot.Path.UNKNOWN
        }

        val now = System.currentTimeMillis()
        var kbps = prev?.kbps ?: 0.0
        if (prev != null && prev.atMs > 0) {
            val dt = (now - prev.atMs) / 1000.0
            if (dt > 0.2) kbps = ((bytes - prev.bytes).coerceAtLeast(0) * 8) / 1000.0 / dt
        }

        return Snapshot(now, bytes, kbps, width, height, fps, lost, rtt, path)
    }

    private fun num(v: Any?): Long = when (v) {
        is BigInteger -> v.toLong()
        is Number -> v.toLong()
        else -> 0L
    }

    fun formatRate(kbps: Double): String = when {
        kbps <= 0 -> "—"
        kbps >= 1000 -> String.format("%.2f Mb/s", kbps / 1000)
        else -> "${kbps.toInt()} kb/s"
    }
}
