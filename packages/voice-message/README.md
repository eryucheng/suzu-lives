# Voice message

This package creates local MP3 audio for the Suzu conversation that requested
it. It does not read external bridge configuration, recipient state, or any
direct WeChat transport.

Its stable command is:

```text
suzu-lives voice-message [text] [--audio-file <local-audio>] [--config <software-data-config>] [--timeout-ms <ms>] [--inspect]
```

The software-owned local configuration is constrained to
`<dataRoot>/capabilities/voice-message/config.json`; the public example is in
`resources/voice-message.config.example.json`. Text synthesis uses the selected
Suzu sound connection and writes usage to the caller-provided Suzu Lives ledger.
Both synthesized and supplied audio are saved as MP3 under
`<dataRoot>/capabilities/voice-message/audio/`.

The command returns the generated `savedPath`. The active conversation must
then call its provided `conversation-attachment --audio "<savedPath>"` command.
That makes the file playable in Suzu and, when the conversation is linked,
sends the same MP3 as a normal WeChat file.

Temporary conversion files stay under
`<dataRoot>/capabilities/voice-message/runtime`. Tests use temporary files and
fake TTS/process adapters; they do not contact a real TTS service or WeChat.
