package ai.less.p2pcam.rtc

import android.content.ContentValues
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageFormat
import android.graphics.Matrix
import android.graphics.Rect
import android.graphics.YuvImage
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import org.webrtc.VideoFrame
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream

/**
 * Turns one WebRTC video frame into a JPEG on the device's own storage.
 *
 * This is the "save a still on the camera" command: the image is written here,
 * on the device holding the lens, and never travels to the viewer or the
 * server. Only the filename and byte count come back over the data channel.
 */
object FrameCapture {

    data class Saved(val name: String, val bytes: Int, val location: String)

    fun encode(frame: VideoFrame): Pair<ByteArray, Pair<Int, Int>>? {
        val i420 = frame.buffer.toI420() ?: return null
        try {
            val w = i420.width
            val h = i420.height
            val nv21 = i420ToNv21(i420, w, h)

            val out = ByteArrayOutputStream()
            YuvImage(nv21, ImageFormat.NV21, w, h, null)
                .compressToJpeg(Rect(0, 0, w, h), 92, out)
            var jpeg = out.toByteArray()
            var dims = w to h

            val rotation = frame.rotation
            if (rotation != 0) {
                val bmp = BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size) ?: return jpeg to dims
                val m = Matrix().apply { postRotate(rotation.toFloat()) }
                val rotated = Bitmap.createBitmap(bmp, 0, 0, bmp.width, bmp.height, m, true)
                val out2 = ByteArrayOutputStream()
                rotated.compress(Bitmap.CompressFormat.JPEG, 92, out2)
                jpeg = out2.toByteArray()
                dims = rotated.width to rotated.height
                if (rotated != bmp) rotated.recycle()
                bmp.recycle()
            }
            return jpeg to dims
        } finally {
            i420.release()
        }
    }

    /** I420 (3 planes, arbitrary strides) to NV21 (Y plane + interleaved VU). */
    private fun i420ToNv21(b: VideoFrame.I420Buffer, w: Int, h: Int): ByteArray {
        val out = ByteArray(w * h * 3 / 2)

        val y = b.dataY
        val strideY = b.strideY
        var o = 0
        for (row in 0 until h) {
            y.position(row * strideY)
            y.get(out, o, w)
            o += w
        }

        val cw = (w + 1) / 2
        val ch = (h + 1) / 2
        val u = b.dataU
        val v = b.dataV
        val strideU = b.strideU
        val strideV = b.strideV

        val uRow = ByteArray(cw)
        val vRow = ByteArray(cw)
        for (row in 0 until ch) {
            u.position(row * strideU)
            u.get(uRow, 0, minOf(cw, u.remaining()))
            v.position(row * strideV)
            v.get(vRow, 0, minOf(cw, v.remaining()))
            for (col in 0 until cw) {
                out[o++] = vRow[col]     // NV21 is V then U
                out[o++] = uRow[col]
            }
        }
        return out
    }

    fun save(context: Context, uid: String, jpeg: ByteArray): Saved {
        val stamp = java.text.SimpleDateFormat("yyyyMMdd_HHmmss", java.util.Locale.US)
            .format(java.util.Date())
        val name = "${uid}_$stamp.jpg"

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val values = ContentValues().apply {
                put(MediaStore.Images.Media.DISPLAY_NAME, name)
                put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg")
                put(MediaStore.Images.Media.RELATIVE_PATH, "${Environment.DIRECTORY_PICTURES}/P2PCam")
            }
            val uri = context.contentResolver
                .insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values)
            if (uri != null) {
                context.contentResolver.openOutputStream(uri)?.use { it.write(jpeg) }
                return Saved(name, jpeg.size, "Pictures/P2PCam")
            }
        }

        // Below Q, and as a fallback: app-specific storage needs no permission.
        val dir = File(context.getExternalFilesDir(Environment.DIRECTORY_PICTURES), "P2PCam")
        dir.mkdirs()
        val f = File(dir, name)
        FileOutputStream(f).use { it.write(jpeg) }
        return Saved(name, jpeg.size, "app storage")
    }
}
