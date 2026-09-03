This manual test was done on my apple macbook m5 pro - so a desktop experience.


Login view -
the UI is not too nice, it has no padding between fields and labels.

> **Addressed.** The label and its input were siblings inside one inline `<label>`, so they
> sat on the same line touching each other. The fields are now stacked and spaced, in a card,
> with 44px controls — and `web/e2e/signin.spec.ts` measures the gap and the control heights
> from the browser's box model, so this cannot silently come back. Two things next to it were
> wrong for the same reason nobody had looked: a refused sign-in rendered a message and *no
> form* (a dead end), and it did so under the note pages' `form-action 'none'`, so even with
> the form there the browser would have refused the retry. SPEC §6.8, §22.6.
