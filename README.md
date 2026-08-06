# Draw a Perfect Circle

One stroke, all the way around a dot, scored on how round it really is. Part of
[Maybaah's Arcade](https://maybaah.github.io/arcade/).

**Play:** https://maybaah.github.io/circle/

## Rules

- A run is one continuous stroke that sweeps a full 360 degrees around the
  centre dot of a fixed 1000x1000 pad.
- The stroke starts **wherever the pointer goes down** and runs **whichever way
  it first turns**. Nothing is prescribed: the direction locks on the first 5
  degrees of turn and holds for the rest of the run.
- The stroke is void if it lifts before the circle closes, doubles back by more
  than 20 degrees, jumps more than 60 degrees around the centre in one sample,
  stalls for more than 1500ms, or leaves the ring between radius 25 and 495.
- A stroke needs at least 24 samples and 250ms. Somewhere around half a second
  is the floor in practice, because a pointer only reports so often, and a
  circle drawn faster than that is not a tape anyone can measure.
- Ranked by accuracy, highest wins.

## How the score works

The sweep is resampled at 180 equal angles, so a fast hand and a slow one are
measured the same way, and a circle is fitted to those 180 samples by Kasa's
algebraic least squares, which is the closed-form fit of

```
x² + y² + Ax + By + C = 0
```

Eight sums and one 3x3 solve, no iteration to go wrong on either side. Fitting
the centre rather than assuming it is what forgives drawing around the wrong
point, because being off centre is not being out of round. The score is what is
left over:

```
accuracy = 1 − mean|distance from the fitted centre − fitted radius| / radius
```

The dashed green circle drawn over a finished stroke is that fit. A stroke that
is geometrically perfect still lands around 99.9%, because the tape carries
integer coordinates and a rounded pixel is a real wobble.

## How a run is verified

Nothing is submitted but evidence: the seed the run was opened with and a tape
of every point the pointer passed through, each written as
`<ms since the last point>,<x>,<y>;`. The start and the direction come off the
tape rather than the seed, so `arcade-leaderboard` reads the same frame out of
the same points, walks the same polyline, applies the same bounds and computes
the accuracy itself. A tape that never closes, runs past the close, backtracks,
stalls or leaves the ring is rejected with a 422.

What a replay cannot check is the clock and the hand behind it: the gaps on the
tape are the browser's own timestamps, and a synthesised stroke is a synthesised
stroke. A free start costs the one thing the marker bought, too, which is that a
tape no longer belongs to the run it was drawn in: the same points verify under
any seed. The floor and ceiling on the gaps, the sample count, the maximum step
and the total time are the whole defence there, and the score itself is still
computed by the Worker rather than accepted from the page.

The engine between the `── the engine ──` markers in
[`game.js`](game.js) is duplicated byte for byte in the arcade Worker. Drift
means the page shows an accuracy the referee does not agree with, and every
submission stops verifying.

## Boards

| Board | What |
| :-- | :-- |
| `classic` | all-time, one row per player, best stroke counts |
| `classic-<YYYYMMDD>` | today's strokes, dated by the Worker's clock |

## Files

```
index.html   page, SEO head, styles
game.js      engine + pad
```

No build step, no dependencies. `/assets/site.css` and `/assets/arcade.js` are
loaded from the root site so every cabinet shares one design system, one player
identity and one wallet.
