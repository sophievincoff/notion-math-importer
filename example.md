# Generator Matching Notes

The model learns an infinitesimal generator $\mathcal{L}_t$ rather than a
finite-time transition kernel.

For a discrete continuous-time Markov chain:

$$
(\mathcal{L}_t f)(x)
=
\sum_{y \ne x} Q_t(x,y)\left[f(y)-f(x)\right].
$$

## Swap-only specialization

- A state is a permutation of a fixed multiset.
- Every transition swaps two positions.
- Token counts are preserved exactly.

For swap rates $r_\theta(i,j\mid x,t)$:

\[
(\mathcal L_t^\theta f)(x)
=
\sum_{i<j}r_\theta(i,j\mid x,t)
\left[f(S_{ij}x)-f(x)\right].
\]
