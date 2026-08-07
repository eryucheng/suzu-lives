# Voice message

This package creates local MP3 audio for the Suzu conversation that requested
it. It does not read external bridge configuration, recipient state, or any
direct WeChat transport.

Its stable command is:

```text
suzu-lives voice-message [text] [--audio-file <local-audio>] [--config <software-data-config>] [--timeout-ms <ms>] [--inspect]
```

The shared, software-owned configuration is constrained to
`<dataRoot>/capabilities/voice-message/config.json`; it contains provider/API
settings, `ffmpegPath`, and the default timeout. The public shared example is
in `resources/voice-message.config.example.json`.

Each contact selects its own voice at
`<dataRoot>/agents/<agentId>/voice-message/config.json`:

```json
{ "schemaVersion": 1, "voiceId": "contact-voice-id" }
```

The selected ID must exist in that contact's
`voice-design/candidates.jsonl` candidate library. For upgrades, an old
`voiceId` in the shared file is used only when it belongs to the current
contact's candidate library; saving the selection or the first real synthesis
then writes the contact file. The shared file is retained unchanged, including
its legacy `voiceId`.

Text synthesis uses the selected Suzu sound connection and writes usage to the
caller-provided Suzu Lives ledger. Both synthesized and supplied audio are
saved as MP3 under
`<dataRoot>/agents/<agentId>/voice-message/audio/`.

The command returns the generated `savedPath`. The active conversation must
then call its provided `conversation-attachment --audio "<savedPath>"` command.
That makes the file playable in Suzu and, when the conversation is linked,
sends the same MP3 as a normal WeChat file.

Temporary conversion files stay under
`<dataRoot>/capabilities/voice-message/runtime`. Tests use temporary files and
fake TTS/process adapters; they do not contact a real TTS service or WeChat.
