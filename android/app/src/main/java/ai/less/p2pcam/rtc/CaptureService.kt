package ai.less.p2pcam.rtc

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import ai.less.p2pcam.R

/**
 * Keeps the camera alive while the app is not on screen.
 *
 * Android refuses camera and microphone access to background apps, so without
 * this a monitoring camera stops the moment the user opens anything else —
 * which for this product is the normal case, not an edge case. A foreground
 * service with the camera and microphone types is the supported way to hold
 * that access, and the persistent notification is the honest disclosure that
 * something is recording.
 */
class CaptureService : android.app.Service() {

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val uid = intent?.getStringExtra(EXTRA_UID) ?: "camera"
        startForeground(NOTIFICATION_ID, buildNotification(uid))
        return START_STICKY
    }

    private fun buildNotification(uid: String): Notification {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Camera streaming",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Shown while this device is publishing its camera"
                setShowBadge(false)
            }
            nm.createNotificationChannel(channel)
        }

        val open = packageManager.getLaunchIntentForPackage(packageName)
        val pending = open?.let {
            PendingIntent.getActivity(
                this, 0, it,
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M)
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                else PendingIntent.FLAG_UPDATE_CURRENT
            )
        }

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Camera live")
            .setContentText(uid)
            .setSmallIcon(R.drawable.ic_stat_camera)
            .setOngoing(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setContentIntent(pending)
            .build()
    }

    companion object {
        private const val CHANNEL_ID = "capture"
        private const val NOTIFICATION_ID = 4711
        private const val EXTRA_UID = "uid"

        fun start(context: Context, uid: String) {
            val i = Intent(context, CaptureService::class.java).putExtra(EXTRA_UID, uid)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(i)
            } else {
                context.startService(i)
            }
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, CaptureService::class.java))
        }
    }
}
