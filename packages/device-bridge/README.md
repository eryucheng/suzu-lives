# Device bridge

This package owns safe plans and gated execution boundaries for computer-camera and iPhone bridge requests.

The bundled OpenCV worker receives only software-owned output/status paths and implements a persistent prewarm → ready → capture → user-confirmed close lifecycle. It accepts only a private, verified one-time authorization context. The iPhone boundary deliberately has no default HTTP path until a releasable Suzu Lives bridge protocol is verified. The package never reads external IMAP/Webhook files, starts a listener, or guesses an endpoint.
