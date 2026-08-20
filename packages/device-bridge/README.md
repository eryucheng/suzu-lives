# Device Bridge

This package owns the computer-camera worker and its guarded lifecycle: prewarm, ready, capture, and explicit user-confirmed close.

The worker receives only software-owned output and status paths. It accepts a private, verified one-time authorization context and never guesses an endpoint, opens unrelated devices, or reads external mailbox/webhook files.
