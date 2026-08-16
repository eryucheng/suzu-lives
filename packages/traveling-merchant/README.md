# Traveling merchant monitor

`@suzu-lives/traveling-merchant` owns the monitor parser, retry behavior,
status file, and stable Agent command:

```text
suzu-lives traveling-merchant [--dry-run] [--force] [--fixture <html>] [--test-notification]
```

The public default settings are bundled in `resources/config.example.json`.
At runtime, a software-side override may be supplied with `--config`; it must
remain below the selected Suzu Lives data root. If no override is present, the
bundled public defaults are used. Runtime state is always written atomically to
`<dataRoot>/automation/traveling-merchant/runtime/state.json`.

The monitor only reads the page and returns a Suzu-owned delivery result. The
Electron scheduler routes that result to every session enabled in the
`traveling-merchant` capability settings. `--dry-run` and `--fixture` are the
safe paths for checking parsing without a page request, delivery result, or
state write.
