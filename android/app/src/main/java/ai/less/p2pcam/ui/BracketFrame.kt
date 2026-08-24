package ai.less.p2pcam.ui

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.util.AttributeSet
import android.view.View
import android.view.animation.LinearInterpolator
import androidx.core.content.ContextCompat
import ai.less.p2pcam.R

/**
 * Viewfinder corner brackets over the video surface, plus a sweep line while a
 * connection is being negotiated.
 *
 * This is the only decorative element in the app. It earns its place because a
 * camera viewfinder is exactly what it depicts — and because a moving line is
 * the clearest way to say "working on it" without a spinner.
 */
class BracketFrame @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyle: Int = 0,
) : View(context, attrs, defStyle) {

    enum class State { IDLE, CONNECTING, LIVE }

    private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = dp(1.5f)
        strokeCap = Paint.Cap.SQUARE
    }
    private val sweep = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }

    private val colIdle = ContextCompat.getColor(context, R.color.line_strong)
    private val colCtrl = ContextCompat.getColor(context, R.color.ctrl)
    private val colLive = ContextCompat.getColor(context, R.color.accent)

    private var animator: ValueAnimator? = null
    private var sweepPos = 0f

    var state: State = State.IDLE
        set(value) {
            if (field == value) return
            field = value
            if (value == State.CONNECTING) startSweep() else stopSweep()
            invalidate()
        }

    private fun dp(v: Float) = v * resources.displayMetrics.density

    private fun startSweep() {
        stopSweep()
        animator = ValueAnimator.ofFloat(0f, 1f).apply {
            duration = 1600
            repeatCount = ValueAnimator.INFINITE
            interpolator = LinearInterpolator()
            addUpdateListener {
                sweepPos = it.animatedValue as Float
                invalidate()
            }
            start()
        }
    }

    private fun stopSweep() {
        animator?.cancel()
        animator = null
    }

    override fun onDetachedFromWindow() {
        stopSweep()
        super.onDetachedFromWindow()
    }

    override fun onDraw(canvas: Canvas) {
        val inset = dp(10f)
        val len = dp(20f)
        val l = inset
        val t = inset
        val r = width - inset
        val b = height - inset
        if (r <= l || b <= t) return

        stroke.color = when (state) {
            State.LIVE -> colLive
            State.CONNECTING -> colCtrl
            State.IDLE -> colIdle
        }

        // four L-brackets, drawn as pairs of short segments
        canvas.drawLine(l, t, l + len, t, stroke)
        canvas.drawLine(l, t, l, t + len, stroke)

        canvas.drawLine(r - len, t, r, t, stroke)
        canvas.drawLine(r, t, r, t + len, stroke)

        canvas.drawLine(l, b - len, l, b, stroke)
        canvas.drawLine(l, b, l + len, b, stroke)

        canvas.drawLine(r - len, b, r, b, stroke)
        canvas.drawLine(r, b - len, r, b, stroke)

        if (state == State.CONNECTING) {
            val y = t + (b - t) * sweepPos
            sweep.color = colCtrl
            sweep.alpha = ((1f - kotlin.math.abs(sweepPos - 0.5f) * 2f) * 150).toInt().coerceIn(0, 255)
            canvas.drawRect(l, y, r, y + dp(1.5f), sweep)
        }
    }
}
