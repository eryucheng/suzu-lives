# Proactive contact

This package owns the lightweight Agent registration content for
proactive-contact behavior. The Electron application owns the scheduler and
stores all one-shot task state below the Suzu data root.

The generated Skill keeps the chain and one-shot follow-up rules while the
current direct conversation supplies the scoped `suzu-lives schedule add`,
`list`, and `remove` command forms. It contains no source paths, data paths,
configuration, credentials, or timer state.
