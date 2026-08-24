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

Each contact selects a saved voice profile at
`<dataRoot>/agents/<agentId>/voice-message/config.json`:

```json
{ "schemaVersion": 5, "voiceProfileId": "voice-profile-id" }
```

Voice services and profiles are stored under `<dataRoot>/voice-message/`.
The profile resolves the request protocol, saved API connection, model, and
voice ID. Contact-owned or shared custom voices are validated against their
saved custom-voice records. A `voiceId` left in the shared file is ignored: a
contact without its own selection receives a `tts_voice_missing` error that
directs the user to configure a contact voice.

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
