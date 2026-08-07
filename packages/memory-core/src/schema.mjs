export const SCHEMA_VERSION = 26;

export const MIGRATIONS = Object.freeze([
  {
    version: 1,
    name: "initial-memory-graph",
    sql: `
      CREATE TABLE IF NOT EXISTS memory_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS source_records (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        source_locator TEXT NOT NULL DEFAULT '',
        external_id TEXT NOT NULL,
        occurred_at TEXT,
        recorded_at TEXT NOT NULL,
        speaker TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        UNIQUE (agent_id, source_kind, external_id)
      ) STRICT;

      CREATE INDEX IF NOT EXISTS source_records_agent_time
        ON source_records (agent_id, occurred_at, recorded_at);

      CREATE TABLE IF NOT EXISTS memory_nodes (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        layer TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL,
        event_date TEXT,
        event_start TEXT,
        event_end TEXT,
        recorded_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active'
          CHECK (status IN ('active', 'superseded', 'disputed', 'archived', 'deleted')),
        confidence REAL NOT NULL DEFAULT 1
          CHECK (confidence >= 0 AND confidence <= 1),
        importance REAL NOT NULL DEFAULT 0.5
          CHECK (importance >= 0 AND importance <= 1),
        perspective TEXT NOT NULL DEFAULT '',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS memory_nodes_agent_kind
        ON memory_nodes (agent_id, kind, status);
      CREATE INDEX IF NOT EXISTS memory_nodes_agent_event
        ON memory_nodes (agent_id, event_date, event_start, event_end);

      CREATE TABLE IF NOT EXISTS memory_sources (
        memory_id TEXT NOT NULL REFERENCES memory_nodes(id) ON DELETE CASCADE,
        source_id TEXT NOT NULL REFERENCES source_records(id) ON DELETE RESTRICT,
        relation TEXT NOT NULL DEFAULT 'evidence',
        created_at TEXT NOT NULL,
        PRIMARY KEY (memory_id, source_id, relation)
      ) STRICT;

      CREATE INDEX IF NOT EXISTS memory_sources_source
        ON memory_sources (source_id, memory_id);

      CREATE TABLE IF NOT EXISTS memory_edges (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        from_memory_id TEXT NOT NULL REFERENCES memory_nodes(id) ON DELETE CASCADE,
        to_memory_id TEXT NOT NULL REFERENCES memory_nodes(id) ON DELETE CASCADE,
        relation TEXT NOT NULL,
        direction TEXT NOT NULL DEFAULT 'directed'
          CHECK (direction IN ('directed', 'undirected')),
        weight REAL NOT NULL DEFAULT 0.5
          CHECK (weight >= 0 AND weight <= 1),
        confidence REAL NOT NULL DEFAULT 1
          CHECK (confidence >= 0 AND confidence <= 1),
        provenance TEXT NOT NULL DEFAULT '',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (agent_id, from_memory_id, to_memory_id, relation)
      ) STRICT;

      CREATE INDEX IF NOT EXISTS memory_edges_from
        ON memory_edges (agent_id, from_memory_id, relation, weight DESC);
      CREATE INDEX IF NOT EXISTS memory_edges_to
        ON memory_edges (agent_id, to_memory_id, relation, weight DESC);

      CREATE TABLE IF NOT EXISTS entities (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        canonical_name TEXT NOT NULL,
        aliases_json TEXT NOT NULL DEFAULT '[]',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (agent_id, kind, canonical_name)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS memory_entities (
        memory_id TEXT NOT NULL REFERENCES memory_nodes(id) ON DELETE CASCADE,
        entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
        role TEXT NOT NULL DEFAULT 'about',
        created_at TEXT NOT NULL,
        PRIMARY KEY (memory_id, entity_id, role)
      ) STRICT;

      CREATE INDEX IF NOT EXISTS memory_entities_entity
        ON memory_entities (entity_id, memory_id);

      CREATE TABLE IF NOT EXISTS memory_embeddings (
        memory_id TEXT NOT NULL REFERENCES memory_nodes(id) ON DELETE CASCADE,
        model TEXT NOT NULL,
        dimensions INTEGER NOT NULL CHECK (dimensions > 0),
        content_hash TEXT NOT NULL,
        vector BLOB NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (memory_id, model)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS import_runs (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        importer TEXT NOT NULL,
        source_path TEXT NOT NULL,
        source_fingerprint TEXT NOT NULL,
        status TEXT NOT NULL
          CHECK (status IN ('running', 'completed', 'failed')),
        records_seen INTEGER NOT NULL DEFAULT 0,
        records_added INTEGER NOT NULL DEFAULT 0,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        error TEXT NOT NULL DEFAULT '',
        metadata_json TEXT NOT NULL DEFAULT '{}'
      ) STRICT;

      CREATE INDEX IF NOT EXISTS import_runs_source
        ON import_runs (agent_id, importer, source_path, started_at DESC);
    `,
  },
  {
    version: 2,
    name: "memory-meaning-and-lifecycle",
    sql: `
      ALTER TABLE memory_nodes ADD COLUMN subject_role TEXT NOT NULL DEFAULT 'unknown'
        CHECK (subject_role IN ('user', 'agent', 'shared', 'other', 'world', 'unknown'));
      ALTER TABLE memory_nodes ADD COLUMN subject_key TEXT NOT NULL DEFAULT '';
      ALTER TABLE memory_nodes ADD COLUMN canonical_key TEXT NOT NULL DEFAULT '';
      ALTER TABLE memory_nodes ADD COLUMN reality TEXT NOT NULL DEFAULT 'real'
        CHECK (reality IN ('real', 'hypothetical', 'fictional', 'roleplay', 'unknown'));
      ALTER TABLE memory_nodes ADD COLUMN evidence_mode TEXT NOT NULL DEFAULT 'imported'
        CHECK (evidence_mode IN ('explicit', 'observed', 'inferred', 'manual', 'imported'));
      ALTER TABLE memory_nodes ADD COLUMN temporal_state TEXT NOT NULL DEFAULT 'historical'
        CHECK (temporal_state IN (
          'current', 'historical', 'planned', 'in_progress',
          'completed', 'cancelled', 'timeless', 'unknown'
        ));
      ALTER TABLE memory_nodes ADD COLUMN revision_action TEXT NOT NULL DEFAULT 'add'
        CHECK (revision_action IN (
          'add', 'reinforce', 'update', 'correct',
          'contradict', 'complete', 'cancel'
        ));
      ALTER TABLE memory_nodes ADD COLUMN valid_from TEXT;
      ALTER TABLE memory_nodes ADD COLUMN valid_to TEXT;

      CREATE INDEX IF NOT EXISTS memory_nodes_canonical
        ON memory_nodes (
          agent_id, subject_role, subject_key, canonical_key, status, updated_at DESC
        );
    `,
  },
  {
    version: 3,
    name: "manual-memory-mutations",
    sql: `
      CREATE TABLE IF NOT EXISTS memory_mutations (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        memory_id TEXT NOT NULL REFERENCES memory_nodes(id) ON DELETE RESTRICT,
        action TEXT NOT NULL
          CHECK (action IN ('edit', 'delete', 'restore')),
        actor TEXT NOT NULL DEFAULT 'human',
        reason TEXT NOT NULL DEFAULT '',
        before_json TEXT NOT NULL,
        after_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS memory_mutations_memory
        ON memory_mutations (agent_id, memory_id, created_at DESC);
    `,
  },
  {
    version: 4,
    name: "memory-identity-time-and-evidence",
    sql: `
      ALTER TABLE source_records ADD COLUMN known_at TEXT;
      UPDATE source_records
      SET known_at = COALESCE(occurred_at, recorded_at)
      WHERE known_at IS NULL;

      ALTER TABLE memory_nodes ADD COLUMN known_at TEXT;
      UPDATE memory_nodes
      SET known_at = COALESCE(event_end, event_start, recorded_at)
      WHERE known_at IS NULL;

      CREATE INDEX IF NOT EXISTS memory_nodes_agent_known
        ON memory_nodes (agent_id, known_at, recorded_at);

      ALTER TABLE memory_sources ADD COLUMN authority TEXT NOT NULL DEFAULT 'legacy_unknown'
        CHECK (authority IN (
          'verbatim_record', 'subject_firsthand', 'participant_firsthand',
          'direct_observation', 'external_record', 'hearsay',
          'model_inference', 'manual', 'legacy_unknown', 'unknown'
        ));
      ALTER TABLE memory_sources ADD COLUMN source_trust REAL NOT NULL DEFAULT 0.5
        CHECK (source_trust >= 0 AND source_trust <= 1);
      ALTER TABLE memory_sources ADD COLUMN evidence_strength REAL NOT NULL DEFAULT 1
        CHECK (evidence_strength >= 0 AND evidence_strength <= 1);
      ALTER TABLE memory_sources ADD COLUMN provenance TEXT NOT NULL DEFAULT '';
      ALTER TABLE memory_sources ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE memory_sources ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';
      UPDATE memory_sources SET updated_at = created_at WHERE updated_at = '';
      UPDATE memory_sources
      SET authority = 'verbatim_record', source_trust = 1
      WHERE relation = 'verbatim';

      CREATE TABLE IF NOT EXISTS memory_actor_roles (
        memory_id TEXT NOT NULL REFERENCES memory_nodes(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL,
        role TEXT NOT NULL
          CHECK (role IN (
            'subject', 'experiencer', 'speaker', 'observer',
            'participant', 'belief_holder', 'preference_holder'
          )),
        actor_role TEXT NOT NULL
          CHECK (actor_role IN ('user', 'agent', 'shared', 'other', 'world', 'unknown')),
        actor_key TEXT NOT NULL DEFAULT '',
        is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
        confidence REAL NOT NULL DEFAULT 1
          CHECK (confidence >= 0 AND confidence <= 1),
        provenance TEXT NOT NULL DEFAULT '',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (memory_id, role, actor_role, actor_key)
      ) STRICT;

      CREATE INDEX IF NOT EXISTS memory_actor_roles_actor
        ON memory_actor_roles (agent_id, actor_role, actor_key, role, memory_id);
      CREATE UNIQUE INDEX IF NOT EXISTS memory_actor_roles_primary_subject
        ON memory_actor_roles (memory_id)
        WHERE role = 'subject' AND is_primary = 1;

      INSERT OR IGNORE INTO memory_actor_roles (
        memory_id, agent_id, role, actor_role, actor_key,
        is_primary, confidence, provenance, metadata_json,
        created_at, updated_at
      )
      SELECT
        id, agent_id, 'subject', subject_role, subject_key,
        1, 1, 'schema-v4-backfill', '{}', created_at, updated_at
      FROM memory_nodes
      WHERE subject_role <> 'unknown';

      INSERT OR IGNORE INTO memory_actor_roles (
        memory_id, agent_id, role, actor_role, actor_key,
        is_primary, confidence, provenance, metadata_json,
        created_at, updated_at
      )
      SELECT
        id, agent_id, 'speaker', subject_role, subject_key,
        1, 1, 'schema-v4-utterance-backfill', '{}', created_at, updated_at
      FROM memory_nodes
      WHERE kind = 'utterance' AND subject_role <> 'unknown';
    `,
  },
  {
    version: 5,
    name: "memory-ingestion-decisions",
    sql: `
      CREATE TABLE IF NOT EXISTS memory_ingestion_decisions (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        batch_id TEXT NOT NULL,
        candidate_index INTEGER NOT NULL CHECK (candidate_index >= 0),
        decision TEXT NOT NULL
          CHECK (decision IN ('store', 'review', 'reject')),
        result_status TEXT NOT NULL,
        review_state TEXT NOT NULL DEFAULT 'not_applicable'
          CHECK (review_state IN ('not_applicable', 'pending', 'accepted', 'dismissed')),
        reason_codes_json TEXT NOT NULL DEFAULT '[]',
        candidate_json TEXT NOT NULL,
        source_refs_json TEXT NOT NULL DEFAULT '[]',
        memory_id TEXT REFERENCES memory_nodes(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (agent_id, batch_id, candidate_index)
      ) STRICT;

      CREATE INDEX IF NOT EXISTS memory_ingestion_decisions_review
        ON memory_ingestion_decisions (agent_id, review_state, created_at DESC);
      CREATE INDEX IF NOT EXISTS memory_ingestion_decisions_batch
        ON memory_ingestion_decisions (agent_id, batch_id, candidate_index);
    `,
  },
  {
    version: 6,
    name: "memory-ingestion-review-resolution",
    sql: `
      ALTER TABLE memory_ingestion_decisions
        ADD COLUMN source_ids_json TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE memory_ingestion_decisions
        ADD COLUMN known_at TEXT;
      ALTER TABLE memory_ingestion_decisions
        ADD COLUMN resolved_candidate_json TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE memory_ingestion_decisions
        ADD COLUMN resolution_note TEXT NOT NULL DEFAULT '';
      ALTER TABLE memory_ingestion_decisions
        ADD COLUMN resolved_by TEXT NOT NULL DEFAULT '';
      ALTER TABLE memory_ingestion_decisions
        ADD COLUMN resolved_at TEXT;
    `,
  },
  {
    version: 7,
    name: "memory-retrieval-traces",
    sql: `
      CREATE TABLE IF NOT EXISTS memory_retrieval_traces (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        query_text TEXT NOT NULL DEFAULT '',
        query_hash TEXT NOT NULL,
        recall_intent TEXT NOT NULL DEFAULT '',
        chain_mode TEXT NOT NULL DEFAULT '',
        result_status TEXT NOT NULL,
        retrieval_mode TEXT NOT NULL DEFAULT '',
        seed_ids_json TEXT NOT NULL DEFAULT '[]',
        selected_ids_json TEXT NOT NULL DEFAULT '[]',
        paths_json TEXT NOT NULL DEFAULT '[]',
        matched_entity_ids_json TEXT NOT NULL DEFAULT '[]',
        context_chars INTEGER NOT NULL DEFAULT 0 CHECK (context_chars >= 0),
        candidate_count INTEGER NOT NULL DEFAULT 0 CHECK (candidate_count >= 0),
        vector_status TEXT NOT NULL DEFAULT '',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS memory_retrieval_traces_agent_time
        ON memory_retrieval_traces (agent_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS memory_retrieval_traces_result
        ON memory_retrieval_traces (agent_id, result_status, created_at DESC);

      CREATE TABLE IF NOT EXISTS memory_retrieval_feedback (
        id TEXT PRIMARY KEY,
        trace_id TEXT NOT NULL REFERENCES memory_retrieval_traces(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL,
        signal TEXT NOT NULL,
        target_memory_ids_json TEXT NOT NULL DEFAULT '[]',
        note TEXT NOT NULL DEFAULT '',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS memory_retrieval_feedback_trace
        ON memory_retrieval_feedback (agent_id, trace_id, created_at ASC);
      CREATE INDEX IF NOT EXISTS memory_retrieval_feedback_signal
        ON memory_retrieval_feedback (agent_id, signal, created_at DESC);
    `,
  },
  {
    version: 8,
    name: "memory-structure-proposals",
    sql: `
      CREATE TABLE IF NOT EXISTS memory_structure_proposals (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        batch_id TEXT NOT NULL DEFAULT '',
        kind TEXT NOT NULL CHECK (kind IN ('episode', 'topic')),
        title TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL,
        subject_role TEXT NOT NULL DEFAULT 'unknown'
          CHECK (subject_role IN ('user', 'agent', 'shared', 'other', 'world', 'unknown')),
        subject_key TEXT NOT NULL DEFAULT '',
        event_date TEXT,
        event_start TEXT,
        event_end TEXT,
        member_ids_json TEXT NOT NULL DEFAULT '[]',
        actor_roles_json TEXT NOT NULL DEFAULT '[]',
        confidence REAL NOT NULL DEFAULT 0.5
          CHECK (confidence >= 0 AND confidence <= 1),
        rationale TEXT NOT NULL DEFAULT '',
        provenance TEXT NOT NULL DEFAULT '',
        proposal_hash TEXT NOT NULL,
        review_state TEXT NOT NULL DEFAULT 'pending'
          CHECK (review_state IN ('pending', 'accepted', 'dismissed')),
        result_memory_id TEXT REFERENCES memory_nodes(id) ON DELETE SET NULL,
        resolution_note TEXT NOT NULL DEFAULT '',
        resolved_by TEXT NOT NULL DEFAULT '',
        resolved_at TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (agent_id, proposal_hash)
      ) STRICT;

      CREATE INDEX IF NOT EXISTS memory_structure_proposals_review
        ON memory_structure_proposals (agent_id, review_state, created_at DESC);
      CREATE INDEX IF NOT EXISTS memory_structure_proposals_batch
        ON memory_structure_proposals (agent_id, batch_id, created_at ASC);
    `,
  },
  {
    version: 9,
    name: "memory-structure-proposal-operations",
    sql: `
      ALTER TABLE memory_structure_proposals
        ADD COLUMN operation TEXT NOT NULL DEFAULT 'create'
          CHECK (operation IN ('create', 'attach'));
      ALTER TABLE memory_structure_proposals
        ADD COLUMN target_memory_id TEXT REFERENCES memory_nodes(id) ON DELETE SET NULL;

      CREATE INDEX IF NOT EXISTS memory_structure_proposals_target
        ON memory_structure_proposals (agent_id, target_memory_id, review_state, created_at DESC);
    `,
  },
  {
    version: 10,
    name: "memory-plasticity-shadow-state",
    sql: `
      CREATE UNIQUE INDEX IF NOT EXISTS memory_nodes_id_agent
        ON memory_nodes (id, agent_id);
      CREATE UNIQUE INDEX IF NOT EXISTS memory_edges_id_agent
        ON memory_edges (id, agent_id);

      CREATE TABLE IF NOT EXISTS memory_accessibility_state (
        memory_id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        value REAL NOT NULL CHECK (value >= 0 AND value <= 1),
        policy_version TEXT NOT NULL,
        last_observation_window_id TEXT NOT NULL DEFAULT '',
        last_applied_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (memory_id, agent_id)
          REFERENCES memory_nodes (id, agent_id) ON DELETE CASCADE
      ) STRICT;

      CREATE INDEX IF NOT EXISTS memory_accessibility_state_agent
        ON memory_accessibility_state (agent_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS memory_edge_relation_utility_state (
        edge_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        intent_view TEXT NOT NULL CHECK (length(trim(intent_view)) > 0),
        value REAL NOT NULL CHECK (value >= 0 AND value <= 1),
        policy_version TEXT NOT NULL,
        last_observation_window_id TEXT NOT NULL DEFAULT '',
        last_applied_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (edge_id, intent_view),
        FOREIGN KEY (edge_id, agent_id)
          REFERENCES memory_edges (id, agent_id) ON DELETE CASCADE
      ) STRICT;

      CREATE INDEX IF NOT EXISTS memory_edge_relation_utility_agent
        ON memory_edge_relation_utility_state (agent_id, intent_view, updated_at DESC);

      CREATE TABLE IF NOT EXISTS memory_plasticity_shadow_runs (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        policy_version TEXT NOT NULL,
        observation_window_id TEXT NOT NULL,
        window_start TEXT NOT NULL,
        window_end TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        candidate_count INTEGER NOT NULL DEFAULT 0 CHECK (candidate_count >= 0),
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        UNIQUE (agent_id, policy_version, observation_window_id),
        CHECK (window_start < window_end)
      ) STRICT;

      CREATE INDEX IF NOT EXISTS memory_plasticity_shadow_runs_agent
        ON memory_plasticity_shadow_runs (agent_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS memory_plasticity_shadow_changes (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES memory_plasticity_shadow_runs(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL,
        target_type TEXT NOT NULL CHECK (target_type IN ('memory', 'edge')),
        target_id TEXT NOT NULL CHECK (length(trim(target_id)) > 0),
        learning_target TEXT NOT NULL
          CHECK (learning_target IN ('accessibility', 'relation-utility', 'manual-review')),
        intent_view TEXT NOT NULL DEFAULT '',
        evidence_class TEXT NOT NULL,
        evidence_tier TEXT NOT NULL,
        candidate_direction TEXT NOT NULL CHECK (candidate_direction IN ('increase', 'decrease', 'hold')),
        current_value REAL NOT NULL CHECK (current_value >= 0 AND current_value <= 1),
        decayed_value REAL NOT NULL CHECK (decayed_value >= 0 AND decayed_value <= 1),
        positive_step REAL NOT NULL DEFAULT 0 CHECK (positive_step >= 0 AND positive_step <= 1),
        negative_step REAL NOT NULL DEFAULT 0 CHECK (negative_step >= 0 AND negative_step <= 1),
        proposed_value REAL NOT NULL CHECK (proposed_value >= 0 AND proposed_value <= 1),
        blocked INTEGER NOT NULL DEFAULT 0 CHECK (blocked IN (0, 1)),
        block_reason TEXT NOT NULL DEFAULT '',
        evidence_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        UNIQUE (run_id, target_type, target_id, learning_target, intent_view),
        CHECK (
          (target_type = 'memory' AND intent_view = '')
          OR (target_type = 'edge' AND length(trim(intent_view)) > 0)
        )
      ) STRICT;

      CREATE INDEX IF NOT EXISTS memory_plasticity_shadow_changes_run
        ON memory_plasticity_shadow_changes (agent_id, run_id, target_type, target_id);
    `,
  },
  {
    version: 11,
    name: "memory-plasticity-manual-application",
    sql: `
      ALTER TABLE memory_plasticity_shadow_changes
        ADD COLUMN target_policy_version TEXT NOT NULL DEFAULT '';
      ALTER TABLE memory_plasticity_shadow_changes
        ADD COLUMN base_state_exists INTEGER NOT NULL DEFAULT 0
          CHECK (base_state_exists IN (0, 1));
      ALTER TABLE memory_plasticity_shadow_changes
        ADD COLUMN base_state_value REAL
          CHECK (base_state_value IS NULL OR (base_state_value >= 0 AND base_state_value <= 1));
      ALTER TABLE memory_plasticity_shadow_changes
        ADD COLUMN base_state_policy_version TEXT NOT NULL DEFAULT '';
      ALTER TABLE memory_plasticity_shadow_changes
        ADD COLUMN base_state_observation_window_id TEXT NOT NULL DEFAULT '';
      ALTER TABLE memory_plasticity_shadow_changes
        ADD COLUMN base_state_applied_at TEXT;

      CREATE UNIQUE INDEX IF NOT EXISTS memory_plasticity_shadow_runs_id_agent
        ON memory_plasticity_shadow_runs (id, agent_id);

      CREATE TABLE IF NOT EXISTS memory_plasticity_applications (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('applied', 'rolled_back')),
        applied_count INTEGER NOT NULL DEFAULT 0 CHECK (applied_count >= 0),
        skipped_count INTEGER NOT NULL DEFAULT 0 CHECK (skipped_count >= 0),
        applied_by TEXT NOT NULL CHECK (length(trim(applied_by)) > 0),
        application_reason TEXT NOT NULL DEFAULT '',
        applied_at TEXT NOT NULL,
        rolled_back_by TEXT NOT NULL DEFAULT '',
        rollback_reason TEXT NOT NULL DEFAULT '',
        rolled_back_at TEXT,
        UNIQUE (agent_id, run_id),
        FOREIGN KEY (run_id, agent_id)
          REFERENCES memory_plasticity_shadow_runs (id, agent_id)
      ) STRICT;

      CREATE UNIQUE INDEX IF NOT EXISTS memory_plasticity_applications_id_agent
        ON memory_plasticity_applications (id, agent_id);
      CREATE INDEX IF NOT EXISTS memory_plasticity_applications_agent
        ON memory_plasticity_applications (agent_id, applied_at DESC);

      CREATE TABLE IF NOT EXISTS memory_plasticity_application_changes (
        id TEXT PRIMARY KEY,
        application_id TEXT NOT NULL,
        shadow_change_id TEXT NOT NULL REFERENCES memory_plasticity_shadow_changes(id),
        agent_id TEXT NOT NULL,
        target_type TEXT NOT NULL CHECK (target_type IN ('memory', 'edge')),
        target_id TEXT NOT NULL CHECK (length(trim(target_id)) > 0),
        intent_view TEXT NOT NULL DEFAULT '',
        target_policy_version TEXT NOT NULL CHECK (length(trim(target_policy_version)) > 0),
        previous_exists INTEGER NOT NULL CHECK (previous_exists IN (0, 1)),
        previous_value REAL CHECK (previous_value IS NULL OR (previous_value >= 0 AND previous_value <= 1)),
        previous_policy_version TEXT NOT NULL DEFAULT '',
        previous_observation_window_id TEXT NOT NULL DEFAULT '',
        previous_applied_at TEXT,
        applied_value REAL NOT NULL CHECK (applied_value >= 0 AND applied_value <= 1),
        created_at TEXT NOT NULL,
        UNIQUE (application_id, target_type, target_id, intent_view),
        FOREIGN KEY (application_id, agent_id)
          REFERENCES memory_plasticity_applications (id, agent_id),
        CHECK (
          (target_type = 'memory' AND intent_view = '')
          OR (target_type = 'edge' AND length(trim(intent_view)) > 0)
        ),
        CHECK (
          (previous_exists = 0 AND previous_value IS NULL)
          OR (previous_exists = 1 AND previous_value IS NOT NULL)
        )
      ) STRICT;

      CREATE INDEX IF NOT EXISTS memory_plasticity_application_changes_application
        ON memory_plasticity_application_changes (agent_id, application_id, target_type, target_id);
    `,
  },
  {
    version: 12,
    name: "memory-relation-proposals",
    sql: `
      CREATE UNIQUE INDEX IF NOT EXISTS source_records_id_agent
        ON source_records (id, agent_id);

      CREATE TABLE IF NOT EXISTS memory_relation_proposals (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        batch_id TEXT NOT NULL DEFAULT '',
        relation TEXT NOT NULL CHECK (relation IN ('causes')),
        from_memory_id TEXT NOT NULL,
        to_memory_id TEXT NOT NULL,
        direction TEXT NOT NULL DEFAULT 'directed' CHECK (direction = 'directed'),
        weight REAL NOT NULL DEFAULT 0.5 CHECK (weight >= 0 AND weight <= 1),
        confidence REAL NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
        rationale TEXT NOT NULL DEFAULT '',
        provenance TEXT NOT NULL DEFAULT '',
        proposal_hash TEXT NOT NULL,
        review_state TEXT NOT NULL DEFAULT 'pending'
          CHECK (review_state IN ('pending', 'accepted', 'dismissed', 'revoked')),
        result_edge_id TEXT REFERENCES memory_edges(id) ON DELETE SET NULL,
        result_edge_updated_at TEXT,
        resolution_note TEXT NOT NULL DEFAULT '',
        resolved_by TEXT NOT NULL DEFAULT '',
        resolved_at TEXT,
        revoked_by TEXT NOT NULL DEFAULT '',
        revocation_note TEXT NOT NULL DEFAULT '',
        revoked_at TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (agent_id, proposal_hash),
        CHECK (from_memory_id <> to_memory_id),
        FOREIGN KEY (from_memory_id, agent_id)
          REFERENCES memory_nodes (id, agent_id) ON DELETE CASCADE,
        FOREIGN KEY (to_memory_id, agent_id)
          REFERENCES memory_nodes (id, agent_id) ON DELETE CASCADE
      ) STRICT;

      CREATE UNIQUE INDEX IF NOT EXISTS memory_relation_proposals_id_agent
        ON memory_relation_proposals (id, agent_id);
      CREATE INDEX IF NOT EXISTS memory_relation_proposals_review
        ON memory_relation_proposals (agent_id, review_state, created_at DESC);
      CREATE INDEX IF NOT EXISTS memory_relation_proposals_batch
        ON memory_relation_proposals (agent_id, batch_id, created_at ASC);
      CREATE INDEX IF NOT EXISTS memory_relation_proposals_endpoints
        ON memory_relation_proposals (
          agent_id, from_memory_id, to_memory_id, relation, review_state
        );

      CREATE TABLE IF NOT EXISTS memory_relation_proposal_evidence (
        proposal_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        endpoint_coverage TEXT NOT NULL
          CHECK (endpoint_coverage IN ('from', 'to', 'both')),
        created_at TEXT NOT NULL,
        PRIMARY KEY (proposal_id, source_id),
        FOREIGN KEY (proposal_id, agent_id)
          REFERENCES memory_relation_proposals (id, agent_id) ON DELETE CASCADE,
        FOREIGN KEY (source_id, agent_id)
          REFERENCES source_records (id, agent_id) ON DELETE RESTRICT
      ) STRICT;

      CREATE INDEX IF NOT EXISTS memory_relation_proposal_evidence_source
        ON memory_relation_proposal_evidence (agent_id, source_id, proposal_id);
    `,
  },
  {
    version: 13,
    name: "memory-consolidation-plans",
    sql: `
      CREATE TABLE IF NOT EXISTS memory_consolidation_runs (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        policy_version TEXT NOT NULL,
        trigger_ids_json TEXT NOT NULL DEFAULT '[]',
        candidate_ids_json TEXT NOT NULL DEFAULT '[]',
        candidate_reasons_json TEXT NOT NULL DEFAULT '{}',
        graph_edge_ids_json TEXT NOT NULL DEFAULT '[]',
        input_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'planned'
          CHECK (status IN ('planned', 'running', 'completed', 'no_proposals', 'failed', 'cancelled')),
        structure_proposal_ids_json TEXT NOT NULL DEFAULT '[]',
        relation_proposal_ids_json TEXT NOT NULL DEFAULT '[]',
        error_message TEXT NOT NULL DEFAULT '',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        UNIQUE (agent_id, policy_version, input_hash)
      ) STRICT;

      CREATE INDEX IF NOT EXISTS memory_consolidation_runs_agent
        ON memory_consolidation_runs (agent_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS memory_consolidation_runs_status
        ON memory_consolidation_runs (agent_id, status, created_at ASC);
    `,
  },
  {
    version: 14,
    name: "memory-preference-state-proposals",
    sql: `
      CREATE TABLE IF NOT EXISTS memory_preference_state_proposals (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        batch_id TEXT NOT NULL DEFAULT '',
        subject_role TEXT NOT NULL
          CHECK (subject_role IN ('user', 'agent', 'shared', 'other')),
        subject_key TEXT NOT NULL CHECK (length(trim(subject_key)) > 0),
        canonical_key TEXT NOT NULL CHECK (length(trim(canonical_key)) > 0),
        subject_label TEXT NOT NULL CHECK (length(trim(subject_label)) > 0),
        object_label TEXT NOT NULL CHECK (length(trim(object_label)) > 0),
        scope_label TEXT NOT NULL DEFAULT '',
        scope_json TEXT NOT NULL DEFAULT '{}',
        previous_memory_id TEXT,
        proposed_level TEXT NOT NULL CHECK (proposed_level IN (
          'situational_tolerance', 'selection_tendency', 'stable_preference',
          'direct_preference', 'explicit_rejection', 'no_conclusion'
        )),
        transition TEXT NOT NULL CHECK (transition IN (
          'create', 'reinforce', 'promote', 'downgrade', 'narrow_scope',
          'replace_explicit', 'challenge'
        )),
        proposed_kind TEXT NOT NULL CHECK (proposed_kind IN ('derived_hypothesis', 'preference')),
        title TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL CHECK (length(trim(content)) > 0),
        evidence_review_mode TEXT NOT NULL DEFAULT 'bounded'
          CHECK (evidence_review_mode IN ('bounded', 'full_canonical')),
        confidence REAL NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
        known_at TEXT NOT NULL,
        valid_from TEXT NOT NULL,
        policy_version TEXT NOT NULL CHECK (length(trim(policy_version)) > 0),
        preview_status TEXT NOT NULL CHECK (length(trim(preview_status)) > 0),
        metrics_json TEXT NOT NULL DEFAULT '{}',
        rationale TEXT NOT NULL DEFAULT '',
        provenance TEXT NOT NULL DEFAULT '',
        proposal_hash TEXT NOT NULL,
        review_state TEXT NOT NULL DEFAULT 'pending'
          CHECK (review_state IN ('pending', 'accepted', 'dismissed')),
        result_memory_id TEXT,
        resolution_note TEXT NOT NULL DEFAULT '',
        resolved_by TEXT NOT NULL DEFAULT '',
        resolved_at TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (agent_id, proposal_hash),
        FOREIGN KEY (previous_memory_id, agent_id)
          REFERENCES memory_nodes (id, agent_id) ON DELETE RESTRICT,
        FOREIGN KEY (result_memory_id, agent_id)
          REFERENCES memory_nodes (id, agent_id) ON DELETE RESTRICT
      ) STRICT;

      CREATE UNIQUE INDEX IF NOT EXISTS memory_preference_state_proposals_id_agent
        ON memory_preference_state_proposals (id, agent_id);
      CREATE INDEX IF NOT EXISTS memory_preference_state_proposals_review
        ON memory_preference_state_proposals (agent_id, review_state, created_at DESC);
      CREATE INDEX IF NOT EXISTS memory_preference_state_proposals_canonical
        ON memory_preference_state_proposals (
          agent_id, subject_role, subject_key, canonical_key, review_state, created_at DESC
        );

      CREATE TABLE IF NOT EXISTS memory_preference_proposal_evidence (
        proposal_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        memory_id TEXT NOT NULL,
        evidence_group_id TEXT NOT NULL CHECK (length(trim(evidence_group_id)) > 0),
        context_id TEXT NOT NULL DEFAULT '',
        signal TEXT NOT NULL CHECK (length(trim(signal)) > 0),
        direction TEXT NOT NULL CHECK (direction IN ('support', 'opposition', 'neutral')),
        confidence REAL NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
        source_ids_json TEXT NOT NULL DEFAULT '[]',
        label_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        PRIMARY KEY (proposal_id, memory_id),
        FOREIGN KEY (proposal_id, agent_id)
          REFERENCES memory_preference_state_proposals (id, agent_id) ON DELETE CASCADE,
        FOREIGN KEY (memory_id, agent_id)
          REFERENCES memory_nodes (id, agent_id) ON DELETE RESTRICT
      ) STRICT;

      CREATE INDEX IF NOT EXISTS memory_preference_proposal_evidence_memory
        ON memory_preference_proposal_evidence (agent_id, memory_id, proposal_id);
    `,
  },
  {
    version: 15,
    name: "generic-state-evidence-ledger",
    sql: `
      CREATE TABLE IF NOT EXISTS memory_state_analysis_runs (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL CHECK (length(trim(agent_id)) > 0),
        batch_id TEXT NOT NULL DEFAULT '',
        state_family TEXT NOT NULL CHECK (length(trim(state_family)) > 0),
        analyzer_role TEXT NOT NULL CHECK (length(trim(analyzer_role)) > 0),
        subject_role TEXT NOT NULL
          CHECK (subject_role IN ('user', 'agent', 'shared', 'other')),
        subject_key TEXT NOT NULL CHECK (length(trim(subject_key)) > 0),
        canonical_key TEXT NOT NULL CHECK (length(trim(canonical_key)) > 0),
        provider TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '',
        prompt_version TEXT NOT NULL CHECK (length(trim(prompt_version)) > 0),
        schema_version TEXT NOT NULL CHECK (length(trim(schema_version)) > 0),
        input_hash TEXT NOT NULL CHECK (length(trim(input_hash)) > 0),
        status TEXT NOT NULL CHECK (status IN (
          'completed', 'abstained', 'rejected', 'failed'
        )),
        output_json TEXT NOT NULL DEFAULT '{}',
        rejected_json TEXT NOT NULL DEFAULT '[]',
        usage_json TEXT NOT NULL DEFAULT '{}',
        cost_amount REAL NOT NULL DEFAULT 0 CHECK (cost_amount >= 0),
        cost_currency TEXT NOT NULL DEFAULT '',
        request_id TEXT NOT NULL DEFAULT '',
        duration_ms INTEGER NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
        error_message TEXT NOT NULL DEFAULT '',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE UNIQUE INDEX IF NOT EXISTS memory_state_analysis_runs_id_agent
        ON memory_state_analysis_runs (id, agent_id);
      CREATE INDEX IF NOT EXISTS memory_state_analysis_runs_target
        ON memory_state_analysis_runs (
          agent_id, state_family, subject_role, subject_key, canonical_key, created_at DESC
        );
      CREATE INDEX IF NOT EXISTS memory_state_analysis_runs_batch
        ON memory_state_analysis_runs (agent_id, batch_id, created_at ASC);

      CREATE TABLE IF NOT EXISTS memory_state_analysis_run_memories (
        analysis_run_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        memory_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        PRIMARY KEY (analysis_run_id, memory_id),
        UNIQUE (analysis_run_id, ordinal),
        FOREIGN KEY (analysis_run_id, agent_id)
          REFERENCES memory_state_analysis_runs (id, agent_id) ON DELETE CASCADE,
        FOREIGN KEY (memory_id, agent_id)
          REFERENCES memory_nodes (id, agent_id) ON DELETE RESTRICT
      ) STRICT;

      CREATE INDEX IF NOT EXISTS memory_state_analysis_run_memories_memory
        ON memory_state_analysis_run_memories (agent_id, memory_id, analysis_run_id);

      CREATE TABLE IF NOT EXISTS memory_state_analysis_run_sources (
        analysis_run_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        PRIMARY KEY (analysis_run_id, source_id),
        UNIQUE (analysis_run_id, ordinal),
        FOREIGN KEY (analysis_run_id, agent_id)
          REFERENCES memory_state_analysis_runs (id, agent_id) ON DELETE CASCADE,
        FOREIGN KEY (source_id, agent_id)
          REFERENCES source_records (id, agent_id) ON DELETE RESTRICT
      ) STRICT;

      CREATE INDEX IF NOT EXISTS memory_state_analysis_run_sources_source
        ON memory_state_analysis_run_sources (agent_id, source_id, analysis_run_id);

      CREATE TABLE IF NOT EXISTS memory_state_evidence_observations (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL CHECK (length(trim(agent_id)) > 0),
        batch_id TEXT NOT NULL DEFAULT '',
        state_family TEXT NOT NULL CHECK (length(trim(state_family)) > 0),
        subject_role TEXT NOT NULL
          CHECK (subject_role IN ('user', 'agent', 'shared', 'other')),
        subject_key TEXT NOT NULL CHECK (length(trim(subject_key)) > 0),
        canonical_key TEXT NOT NULL CHECK (length(trim(canonical_key)) > 0),
        memory_id TEXT NOT NULL,
        evidence_group_id TEXT NOT NULL CHECK (length(trim(evidence_group_id)) > 0),
        context_id TEXT NOT NULL DEFAULT '',
        signal TEXT NOT NULL CHECK (length(trim(signal)) > 0),
        claimed_direction TEXT NOT NULL
          CHECK (claimed_direction IN ('support', 'opposition', 'neutral')),
        effective_direction TEXT NOT NULL
          CHECK (effective_direction IN ('support', 'opposition', 'neutral')),
        qualification TEXT NOT NULL
          CHECK (qualification IN ('qualified', 'excluded', 'unresolved')),
        confidence REAL NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
        origin TEXT NOT NULL
          CHECK (origin IN ('llm', 'deterministic', 'manual', 'imported')),
        scope_json TEXT NOT NULL DEFAULT '{}',
        payload_schema_version TEXT NOT NULL CHECK (length(trim(payload_schema_version)) > 0),
        payload_json TEXT NOT NULL DEFAULT '{}',
        excluded_reason TEXT NOT NULL DEFAULT '',
        observation_hash TEXT NOT NULL CHECK (length(trim(observation_hash)) > 0),
        lifecycle TEXT NOT NULL DEFAULT 'current'
          CHECK (lifecycle IN ('current', 'superseded', 'withdrawn')),
        supersedes_observation_id TEXT,
        observed_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (agent_id, observation_hash),
        FOREIGN KEY (memory_id, agent_id)
          REFERENCES memory_nodes (id, agent_id) ON DELETE RESTRICT,
        FOREIGN KEY (supersedes_observation_id, agent_id)
          REFERENCES memory_state_evidence_observations (id, agent_id) ON DELETE RESTRICT
      ) STRICT;

      CREATE UNIQUE INDEX IF NOT EXISTS memory_state_evidence_observations_id_agent
        ON memory_state_evidence_observations (id, agent_id);
      CREATE UNIQUE INDEX IF NOT EXISTS memory_state_evidence_observations_current_target
        ON memory_state_evidence_observations (
          agent_id, state_family, subject_role, subject_key, canonical_key, memory_id
        ) WHERE lifecycle = 'current';
      CREATE INDEX IF NOT EXISTS memory_state_evidence_observations_target
        ON memory_state_evidence_observations (
          agent_id, state_family, subject_role, subject_key, canonical_key,
          lifecycle, observed_at DESC
        );
      CREATE INDEX IF NOT EXISTS memory_state_evidence_observations_memory
        ON memory_state_evidence_observations (agent_id, memory_id, lifecycle);

      CREATE TABLE IF NOT EXISTS memory_state_observation_sources (
        observation_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (observation_id, source_id),
        FOREIGN KEY (observation_id, agent_id)
          REFERENCES memory_state_evidence_observations (id, agent_id) ON DELETE CASCADE,
        FOREIGN KEY (source_id, agent_id)
          REFERENCES source_records (id, agent_id) ON DELETE RESTRICT
      ) STRICT;

      CREATE INDEX IF NOT EXISTS memory_state_observation_sources_source
        ON memory_state_observation_sources (agent_id, source_id, observation_id);

      CREATE TABLE IF NOT EXISTS memory_state_observation_runs (
        observation_id TEXT NOT NULL,
        analysis_run_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (observation_id, analysis_run_id),
        FOREIGN KEY (observation_id, agent_id)
          REFERENCES memory_state_evidence_observations (id, agent_id) ON DELETE CASCADE,
        FOREIGN KEY (analysis_run_id, agent_id)
          REFERENCES memory_state_analysis_runs (id, agent_id) ON DELETE RESTRICT
      ) STRICT;

      CREATE INDEX IF NOT EXISTS memory_state_observation_runs_analysis
        ON memory_state_observation_runs (agent_id, analysis_run_id, observation_id);
    `,
  },
  {
    version: 16,
    name: "memory-representation-layer",
    sql: `
      ALTER TABLE memory_nodes
        ADD COLUMN representation_layer TEXT NOT NULL DEFAULT 'unspecified'
          CHECK (representation_layer IN ('unspecified', 'reported', 'inferred', 'established'));

      CREATE INDEX IF NOT EXISTS memory_nodes_canonical_representation
        ON memory_nodes (
          agent_id, subject_role, subject_key, canonical_key,
          representation_layer, status, valid_from DESC, known_at DESC
        );
    `,
  },
  {
    version: 17,
    name: "memory-state-family-and-phase",
    sql: `
      ALTER TABLE memory_nodes
        ADD COLUMN state_family TEXT NOT NULL DEFAULT 'unspecified'
          CHECK (state_family IN (
            'not_applicable', 'unspecified',
            'identity', 'belief', 'preference', 'habit', 'disposition', 'value',
            'goal', 'capability', 'relationship', 'affective_association',
            'self_concept', 'condition'
          ));

      ALTER TABLE memory_nodes
        ADD COLUMN state_phase TEXT NOT NULL DEFAULT 'unspecified'
          CHECK (state_phase IN (
            'not_applicable', 'unspecified', 'active', 'paused', 'interrupted',
            'completed', 'cancelled', 'ended', 'retired'
          ));

      UPDATE memory_nodes
      SET state_family = 'not_applicable', state_phase = 'not_applicable'
      WHERE kind IN ('utterance', 'event', 'episode', 'topic', 'topic_or_episode', 'reflection');

      CREATE INDEX IF NOT EXISTS memory_nodes_canonical_state_family
        ON memory_nodes (
          agent_id, subject_role, subject_key, canonical_key,
          state_family, representation_layer, status,
          valid_from DESC, known_at DESC
        );
    `,
  },
  {
    version: 18,
    name: "reported-state-review-proposals",
    sql: `
      CREATE TABLE IF NOT EXISTS memory_reported_state_proposals (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL CHECK (length(trim(agent_id)) > 0),
        batch_id TEXT NOT NULL DEFAULT '',
        state_family TEXT NOT NULL CHECK (state_family IN (
          'identity', 'belief', 'preference', 'habit', 'disposition', 'value',
          'goal', 'capability', 'relationship', 'affective_association',
          'self_concept', 'condition'
        )),
        subject_role TEXT NOT NULL
          CHECK (subject_role IN ('user', 'agent', 'shared', 'other')),
        subject_key TEXT NOT NULL CHECK (length(trim(subject_key)) > 0),
        canonical_key TEXT NOT NULL CHECK (length(trim(canonical_key)) > 0),
        representation_layer TEXT NOT NULL DEFAULT 'reported'
          CHECK (representation_layer = 'reported'),
        action TEXT NOT NULL CHECK (action IN (
          'create', 'reinforce', 'narrow_scope', 'add_scoped_exception',
          'supersede', 'pause', 'resume', 'progress_update', 'complete',
          'cancel', 'end', 'retire', 'interrupt', 'stop', 'revoke',
          'correct_attribution'
        )),
        previous_memory_id TEXT,
        proposed_kind TEXT NOT NULL DEFAULT '',
        state_phase TEXT NOT NULL DEFAULT 'unspecified'
          CHECK (state_phase IN (
            'unspecified', 'active', 'paused', 'interrupted',
            'completed', 'cancelled', 'ended', 'retired'
          )),
        temporal_state TEXT NOT NULL DEFAULT 'unknown'
          CHECK (temporal_state IN (
            'current', 'historical', 'planned', 'in_progress', 'completed',
            'cancelled', 'timeless', 'unknown'
          )),
        draft_json TEXT NOT NULL DEFAULT '{}',
        review_version TEXT NOT NULL CHECK (length(trim(review_version)) > 0),
        input_hash TEXT NOT NULL CHECK (length(trim(input_hash)) > 0),
        proposal_hash TEXT NOT NULL CHECK (length(trim(proposal_hash)) > 0),
        review_state TEXT NOT NULL DEFAULT 'pending'
          CHECK (review_state IN ('pending', 'accepted', 'dismissed')),
        result_memory_id TEXT,
        resolution_note TEXT NOT NULL DEFAULT '',
        resolved_by TEXT NOT NULL DEFAULT '',
        resolved_at TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (agent_id, proposal_hash),
        FOREIGN KEY (previous_memory_id, agent_id)
          REFERENCES memory_nodes (id, agent_id) ON DELETE RESTRICT,
        FOREIGN KEY (result_memory_id, agent_id)
          REFERENCES memory_nodes (id, agent_id) ON DELETE RESTRICT
      ) STRICT;

      CREATE UNIQUE INDEX IF NOT EXISTS memory_reported_state_proposals_id_agent
        ON memory_reported_state_proposals (id, agent_id);
      CREATE INDEX IF NOT EXISTS memory_reported_state_proposals_review
        ON memory_reported_state_proposals (
          agent_id, review_state, created_at DESC
        );
      CREATE INDEX IF NOT EXISTS memory_reported_state_proposals_target
        ON memory_reported_state_proposals (
          agent_id, state_family, subject_role, subject_key, canonical_key,
          review_state, created_at DESC
        );

      CREATE TABLE IF NOT EXISTS memory_reported_state_proposal_observations (
        proposal_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        observation_id TEXT NOT NULL,
        evidence_role TEXT NOT NULL
          CHECK (evidence_role IN ('selected', 'considered')),
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        created_at TEXT NOT NULL,
        PRIMARY KEY (proposal_id, observation_id),
        UNIQUE (proposal_id, evidence_role, ordinal),
        FOREIGN KEY (proposal_id, agent_id)
          REFERENCES memory_reported_state_proposals (id, agent_id) ON DELETE CASCADE,
        FOREIGN KEY (observation_id, agent_id)
          REFERENCES memory_state_evidence_observations (id, agent_id) ON DELETE RESTRICT
      ) STRICT;

      CREATE INDEX IF NOT EXISTS memory_reported_state_proposal_observations_observation
        ON memory_reported_state_proposal_observations (
          agent_id, observation_id, proposal_id
        );
    `,
  },
  {
    version: 19,
    name: "scoped-current-state-identity",
    sql: `
      ALTER TABLE memory_nodes
        ADD COLUMN state_scope_key TEXT NOT NULL DEFAULT 'root'
          CHECK (
            state_scope_key IN ('not_applicable', 'root')
            OR (
              length(state_scope_key) = 70
              AND substr(state_scope_key, 1, 6) = 'scope:'
              AND substr(state_scope_key, 7) NOT GLOB '*[^0-9a-f]*'
            )
          );

      UPDATE memory_nodes
      SET state_scope_key = 'not_applicable'
      WHERE state_family = 'not_applicable';

      ALTER TABLE memory_reported_state_proposals
        ADD COLUMN target_scope_key TEXT NOT NULL DEFAULT 'root'
          CHECK (
            target_scope_key = 'root'
            OR (
              length(target_scope_key) = 70
              AND substr(target_scope_key, 1, 6) = 'scope:'
              AND substr(target_scope_key, 7) NOT GLOB '*[^0-9a-f]*'
            )
          );

      ALTER TABLE memory_reported_state_proposals
        ADD COLUMN proposed_scope_key TEXT NOT NULL DEFAULT 'root'
          CHECK (
            proposed_scope_key = 'root'
            OR (
              length(proposed_scope_key) = 70
              AND substr(proposed_scope_key, 1, 6) = 'scope:'
              AND substr(proposed_scope_key, 7) NOT GLOB '*[^0-9a-f]*'
            )
          );

      CREATE INDEX IF NOT EXISTS memory_nodes_canonical_state_scope
        ON memory_nodes (
          agent_id, subject_role, subject_key, canonical_key,
          state_family, representation_layer, state_scope_key, status,
          valid_from DESC, known_at DESC
        );

      CREATE INDEX IF NOT EXISTS memory_reported_state_proposals_scope
        ON memory_reported_state_proposals (
          agent_id, state_family, subject_role, subject_key, canonical_key,
          target_scope_key, proposed_scope_key, review_state, created_at DESC
        );
    `,
  },
  {
    version: 20,
    name: "preference-proposal-state-identity",
    sql: `
      ALTER TABLE memory_preference_state_proposals
        ADD COLUMN representation_layer TEXT NOT NULL DEFAULT 'inferred'
          CHECK (representation_layer IN ('reported', 'inferred', 'established'));

      UPDATE memory_preference_state_proposals
      SET representation_layer = 'reported'
      WHERE proposed_level IN ('direct_preference', 'explicit_rejection');

      ALTER TABLE memory_preference_state_proposals
        ADD COLUMN state_scope_key TEXT NOT NULL DEFAULT 'root'
          CHECK (
            state_scope_key = 'root'
            OR (
              length(state_scope_key) = 70
              AND substr(state_scope_key, 1, 6) = 'scope:'
              AND substr(state_scope_key, 7) NOT GLOB '*[^0-9a-f]*'
            )
          );

      ALTER TABLE memory_preference_proposal_evidence
        ADD COLUMN evidence_snapshot_hash TEXT NOT NULL DEFAULT '';

      CREATE INDEX IF NOT EXISTS memory_preference_state_proposals_identity
        ON memory_preference_state_proposals (
          agent_id, subject_role, subject_key, canonical_key,
          representation_layer, state_scope_key, review_state, created_at DESC
        );
    `,
  },
  {
    version: 21,
    name: "state-promotion-proposals",
    sql: `
      CREATE TABLE IF NOT EXISTS memory_state_promotion_proposals (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL CHECK (length(trim(agent_id)) > 0),
        state_family TEXT NOT NULL CHECK (state_family IN (
          'identity', 'belief', 'preference', 'habit', 'disposition', 'value',
          'goal', 'capability', 'relationship', 'affective_association',
          'self_concept', 'condition'
        )),
        subject_role TEXT NOT NULL
          CHECK (subject_role IN ('user', 'agent', 'shared', 'other')),
        subject_key TEXT NOT NULL CHECK (length(trim(subject_key)) > 0),
        canonical_key TEXT NOT NULL CHECK (length(trim(canonical_key)) > 0),
        state_scope_key TEXT NOT NULL DEFAULT 'root'
          CHECK (
            state_scope_key = 'root'
            OR (
              length(state_scope_key) = 70
              AND substr(state_scope_key, 1, 6) = 'scope:'
              AND substr(state_scope_key, 7) NOT GLOB '*[^0-9a-f]*'
            )
          ),
        source_memory_id TEXT NOT NULL,
        source_representation_layer TEXT NOT NULL DEFAULT 'inferred'
          CHECK (source_representation_layer = 'inferred'),
        target_representation_layer TEXT NOT NULL DEFAULT 'established'
          CHECK (target_representation_layer = 'established'),
        proposed_kind TEXT NOT NULL CHECK (length(trim(proposed_kind)) > 0),
        title TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL CHECK (length(trim(content)) > 0),
        confidence REAL NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
        known_at TEXT NOT NULL,
        valid_from TEXT NOT NULL,
        policy_version TEXT NOT NULL CHECK (length(trim(policy_version)) > 0),
        source_snapshot_hash TEXT NOT NULL CHECK (length(source_snapshot_hash) = 64),
        proposal_hash TEXT NOT NULL CHECK (length(proposal_hash) = 64),
        review_state TEXT NOT NULL DEFAULT 'pending'
          CHECK (review_state IN ('pending', 'accepted', 'dismissed', 'revoked')),
        result_memory_id TEXT,
        resolution_note TEXT NOT NULL DEFAULT '',
        resolved_by TEXT NOT NULL DEFAULT '',
        resolved_at TEXT,
        revoked_by TEXT NOT NULL DEFAULT '',
        revocation_note TEXT NOT NULL DEFAULT '',
        revoked_at TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (agent_id, proposal_hash),
        FOREIGN KEY (source_memory_id, agent_id)
          REFERENCES memory_nodes (id, agent_id) ON DELETE RESTRICT,
        FOREIGN KEY (result_memory_id, agent_id)
          REFERENCES memory_nodes (id, agent_id) ON DELETE RESTRICT
      ) STRICT;

      CREATE UNIQUE INDEX IF NOT EXISTS memory_state_promotion_proposals_id_agent
        ON memory_state_promotion_proposals (id, agent_id);
      CREATE INDEX IF NOT EXISTS memory_state_promotion_proposals_review
        ON memory_state_promotion_proposals (
          agent_id, review_state, created_at DESC
        );
      CREATE INDEX IF NOT EXISTS memory_state_promotion_proposals_identity
        ON memory_state_promotion_proposals (
          agent_id, state_family, subject_role, subject_key, canonical_key,
          state_scope_key, review_state, created_at DESC
        );
    `,
  },
  {
    version: 22,
    name: "state-analysis-requests",
    sql: `
      CREATE TABLE IF NOT EXISTS memory_state_analysis_requests (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL CHECK (length(trim(agent_id)) > 0),
        batch_id TEXT NOT NULL CHECK (length(trim(batch_id)) > 0),
        candidate_index INTEGER NOT NULL CHECK (candidate_index >= 0),
        state_family TEXT NOT NULL CHECK (state_family IN (
          'identity', 'belief', 'preference', 'habit', 'disposition', 'value',
          'goal', 'capability', 'relationship', 'affective_association',
          'self_concept', 'condition'
        )),
        subject_role TEXT NOT NULL
          CHECK (subject_role IN ('user', 'agent', 'shared', 'other')),
        subject_key TEXT NOT NULL CHECK (length(trim(subject_key)) > 0),
        canonical_key TEXT NOT NULL CHECK (length(trim(canonical_key)) > 0),
        target_label TEXT NOT NULL CHECK (length(trim(target_label)) > 0),
        representation_layer TEXT NOT NULL
          CHECK (representation_layer IN ('reported', 'inferred')),
        evidence_mode TEXT NOT NULL
          CHECK (evidence_mode IN ('explicit', 'observed', 'inferred')),
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'completed', 'blocked', 'failed', 'cancelled')),
        input_hash TEXT NOT NULL CHECK (length(input_hash) = 64),
        analysis_batch_id TEXT NOT NULL DEFAULT '',
        error_message TEXT NOT NULL DEFAULT '',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (agent_id, batch_id, candidate_index),
        UNIQUE (agent_id, input_hash)
      ) STRICT;

      CREATE UNIQUE INDEX IF NOT EXISTS memory_state_analysis_requests_id_agent
        ON memory_state_analysis_requests (id, agent_id);
      CREATE INDEX IF NOT EXISTS memory_state_analysis_requests_pending
        ON memory_state_analysis_requests (
          agent_id, status, state_family, created_at ASC
        );
      CREATE INDEX IF NOT EXISTS memory_state_analysis_requests_target
        ON memory_state_analysis_requests (
          agent_id, state_family, subject_role, subject_key, canonical_key,
          representation_layer, created_at DESC
        );

      CREATE TABLE IF NOT EXISTS memory_state_analysis_request_memories (
        request_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        memory_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        PRIMARY KEY (request_id, memory_id),
        UNIQUE (request_id, ordinal),
        FOREIGN KEY (request_id, agent_id)
          REFERENCES memory_state_analysis_requests (id, agent_id) ON DELETE CASCADE,
        FOREIGN KEY (memory_id, agent_id)
          REFERENCES memory_nodes (id, agent_id) ON DELETE RESTRICT
      ) STRICT;

      CREATE INDEX IF NOT EXISTS memory_state_analysis_request_memories_memory
        ON memory_state_analysis_request_memories (agent_id, memory_id, request_id);

      CREATE TABLE IF NOT EXISTS memory_state_analysis_request_sources (
        request_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        PRIMARY KEY (request_id, source_id),
        UNIQUE (request_id, ordinal),
        FOREIGN KEY (request_id, agent_id)
          REFERENCES memory_state_analysis_requests (id, agent_id) ON DELETE CASCADE,
        FOREIGN KEY (source_id, agent_id)
          REFERENCES source_records (id, agent_id) ON DELETE RESTRICT
      ) STRICT;

      CREATE INDEX IF NOT EXISTS memory_state_analysis_request_sources_source
        ON memory_state_analysis_request_sources (agent_id, source_id, request_id);
    `,
  },
  {
    version: 23,
    name: "state-analysis-target-spec",
    sql: `
      ALTER TABLE memory_state_analysis_requests
        ADD COLUMN target_spec_json TEXT NOT NULL DEFAULT '{}'
          CHECK (json_valid(target_spec_json) AND json_type(target_spec_json) = 'object');
    `,
  },
  {
    version: 24,
    name: "retrieval-usage-analysis-requests",
    sql: `
      CREATE UNIQUE INDEX IF NOT EXISTS memory_retrieval_traces_id_agent
        ON memory_retrieval_traces (id, agent_id);

      CREATE TABLE IF NOT EXISTS memory_retrieval_session_heads (
        agent_id TEXT NOT NULL CHECK (length(trim(agent_id)) > 0),
        session_id TEXT NOT NULL CHECK (length(trim(session_id)) > 0),
        trace_id TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (agent_id, session_id),
        FOREIGN KEY (trace_id, agent_id)
          REFERENCES memory_retrieval_traces (id, agent_id) ON DELETE CASCADE
      ) STRICT;

      CREATE TABLE IF NOT EXISTS memory_retrieval_usage_requests (
        id TEXT PRIMARY KEY,
        trace_id TEXT NOT NULL,
        agent_id TEXT NOT NULL CHECK (length(trim(agent_id)) > 0),
        session_id TEXT NOT NULL CHECK (length(trim(session_id)) > 0),
        response_text TEXT NOT NULL CHECK (length(trim(response_text)) > 0),
        response_hash TEXT NOT NULL CHECK (length(response_hash) = 64),
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'completed', 'blocked', 'cancelled')),
        result_json TEXT NOT NULL DEFAULT '{}'
          CHECK (json_valid(result_json) AND json_type(result_json) = 'object'),
        error_message TEXT NOT NULL DEFAULT '',
        metadata_json TEXT NOT NULL DEFAULT '{}'
          CHECK (json_valid(metadata_json) AND json_type(metadata_json) = 'object'),
        resolved_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (agent_id, trace_id),
        FOREIGN KEY (trace_id, agent_id)
          REFERENCES memory_retrieval_traces (id, agent_id) ON DELETE CASCADE
      ) STRICT;

      CREATE UNIQUE INDEX IF NOT EXISTS memory_retrieval_usage_requests_id_agent
        ON memory_retrieval_usage_requests (id, agent_id);
      CREATE INDEX IF NOT EXISTS memory_retrieval_usage_requests_pending
        ON memory_retrieval_usage_requests (agent_id, status, created_at ASC);
      CREATE INDEX IF NOT EXISTS memory_retrieval_usage_requests_session
        ON memory_retrieval_usage_requests (agent_id, session_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS memory_retrieval_usage_analysis_runs (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        trace_id TEXT NOT NULL,
        agent_id TEXT NOT NULL CHECK (length(trim(agent_id)) > 0),
        provider TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '',
        prompt_version TEXT NOT NULL CHECK (length(trim(prompt_version)) > 0),
        schema_version TEXT NOT NULL CHECK (length(trim(schema_version)) > 0),
        input_hash TEXT NOT NULL CHECK (length(input_hash) = 64),
        status TEXT NOT NULL CHECK (status IN ('completed', 'rejected', 'failed')),
        output_json TEXT NOT NULL DEFAULT '{}'
          CHECK (json_valid(output_json) AND json_type(output_json) = 'object'),
        usage_json TEXT NOT NULL DEFAULT '{}'
          CHECK (json_valid(usage_json) AND json_type(usage_json) = 'object'),
        request_external_id TEXT NOT NULL DEFAULT '',
        duration_ms INTEGER NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
        error_message TEXT NOT NULL DEFAULT '',
        metadata_json TEXT NOT NULL DEFAULT '{}'
          CHECK (json_valid(metadata_json) AND json_type(metadata_json) = 'object'),
        created_at TEXT NOT NULL,
        FOREIGN KEY (request_id, agent_id)
          REFERENCES memory_retrieval_usage_requests (id, agent_id) ON DELETE CASCADE,
        FOREIGN KEY (trace_id, agent_id)
          REFERENCES memory_retrieval_traces (id, agent_id) ON DELETE CASCADE
      ) STRICT;

      CREATE INDEX IF NOT EXISTS memory_retrieval_usage_analysis_runs_request
        ON memory_retrieval_usage_analysis_runs (agent_id, request_id, created_at ASC);
    `,
  },
  {
    version: 25,
    name: "affective-activation-decisions",
    sql: `
      CREATE TABLE IF NOT EXISTS memory_affective_activation_decisions (
        id TEXT PRIMARY KEY,
        memory_id TEXT NOT NULL,
        agent_id TEXT NOT NULL CHECK (length(trim(agent_id)) > 0),
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        policy_version TEXT NOT NULL CHECK (length(trim(policy_version)) > 0),
        actor TEXT NOT NULL CHECK (length(trim(actor)) > 0),
        reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
        created_at TEXT NOT NULL,
        FOREIGN KEY (memory_id, agent_id)
          REFERENCES memory_nodes (id, agent_id) ON DELETE CASCADE
      ) STRICT;

      CREATE INDEX IF NOT EXISTS memory_affective_activation_decisions_memory
        ON memory_affective_activation_decisions
          (agent_id, memory_id, created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS memory_affective_activation_decisions_agent
        ON memory_affective_activation_decisions
          (agent_id, enabled, policy_version, created_at DESC);
    `,
  },
  {
    version: 26,
    name: "legacy-subject-attribution-proposals",
    sql: `
      CREATE TABLE IF NOT EXISTS memory_subject_attribution_proposals (
        id TEXT PRIMARY KEY,
        memory_id TEXT NOT NULL,
        agent_id TEXT NOT NULL CHECK (length(trim(agent_id)) > 0),
        proposed_subject_role TEXT NOT NULL
          CHECK (proposed_subject_role IN ('user', 'agent', 'shared', 'other', 'world')),
        proposed_subject_key TEXT NOT NULL,
        actor_roles_json TEXT NOT NULL DEFAULT '[]'
          CHECK (json_valid(actor_roles_json) AND json_type(actor_roles_json) = 'array'),
        allowed_actors_json TEXT NOT NULL DEFAULT '[]'
          CHECK (json_valid(allowed_actors_json) AND json_type(allowed_actors_json) = 'array'),
        source_snapshot_hash TEXT NOT NULL CHECK (length(source_snapshot_hash) = 64),
        proposal_hash TEXT NOT NULL CHECK (length(proposal_hash) = 64),
        policy_version TEXT NOT NULL CHECK (length(trim(policy_version)) > 0),
        confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
        rationale TEXT NOT NULL CHECK (length(trim(rationale)) > 0),
        review_state TEXT NOT NULL DEFAULT 'pending'
          CHECK (review_state IN ('pending', 'accepted', 'dismissed')),
        resolved_by TEXT NOT NULL DEFAULT '',
        resolution_note TEXT NOT NULL DEFAULT '',
        resolved_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (agent_id, proposal_hash),
        FOREIGN KEY (memory_id, agent_id)
          REFERENCES memory_nodes (id, agent_id) ON DELETE RESTRICT
      ) STRICT;

      CREATE UNIQUE INDEX IF NOT EXISTS memory_subject_attribution_proposals_id_agent
        ON memory_subject_attribution_proposals (id, agent_id);
      CREATE INDEX IF NOT EXISTS memory_subject_attribution_proposals_review
        ON memory_subject_attribution_proposals
          (agent_id, review_state, created_at ASC);
      CREATE INDEX IF NOT EXISTS memory_subject_attribution_proposals_memory
        ON memory_subject_attribution_proposals
          (agent_id, memory_id, review_state, created_at DESC);

      CREATE TABLE IF NOT EXISTS memory_subject_attribution_proposal_evidence (
        proposal_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        PRIMARY KEY (proposal_id, source_id),
        UNIQUE (proposal_id, ordinal),
        FOREIGN KEY (proposal_id, agent_id)
          REFERENCES memory_subject_attribution_proposals (id, agent_id) ON DELETE CASCADE,
        FOREIGN KEY (source_id, agent_id)
          REFERENCES source_records (id, agent_id) ON DELETE RESTRICT
      ) STRICT;

      CREATE INDEX IF NOT EXISTS memory_subject_attribution_proposal_evidence_source
        ON memory_subject_attribution_proposal_evidence
          (agent_id, source_id, proposal_id);
    `,
  },
]);
