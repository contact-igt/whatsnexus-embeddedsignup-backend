/**
 * Cross-database tenant migration preflight.
 *
 * This deliberately does not import ../database/index.js: the application db
 * singleton can connect to only one database. Supply two job-secret URLs:
 * SOURCE_DATABASE_URL (a SELECT-only MySQL user) and DESTINATION_DATABASE_URL.
 *
 *   node src/scripts/migrateTenantData.js --source-tenant TT005 --target-tenant NEW --dry-run
 */
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import dotenv from "dotenv";
import { Sequelize } from "sequelize";

// One-off local runs may keep the two job-secret URLs in invictus-chatbot/.env.
dotenv.config();

const usage = `Usage: node src/scripts/migrateTenantData.js --source-tenant <id> --target-tenant <id> --dry-run | --apply

Required environment variables:
  SOURCE_DATABASE_URL       mysql://SELECT_ONLY_USER:password@host:3306/old_whatsnexus
  DESTINATION_DATABASE_URL  mysql://WRITE_USER:password@host:3306/whatsNexus_embedded`;

export function parseArgs(argv) {
  const options = { mode: null, sourceTenant: null, targetTenant: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run" || arg === "--apply") {
      if (options.mode) throw new Error("Choose exactly one of --dry-run or --apply.");
      options.mode = arg.slice(2);
    } else if (arg === "--source-tenant" || arg === "--target-tenant") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value.`);
      options[arg === "--source-tenant" ? "sourceTenant" : "targetTenant"] = value;
    } else if (arg === "--help" || arg === "-h") {
      return { help: true };
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

export function validateOptions(options, env = process.env) {
  if (!options.mode || !options.sourceTenant || !options.targetTenant) throw new Error(usage);
  if (options.sourceTenant === options.targetTenant) {
    throw new Error("SOURCE_TENANT_ID and TARGET_TENANT_ID must be different.");
  }
  if (!env.SOURCE_DATABASE_URL || !env.DESTINATION_DATABASE_URL) throw new Error(usage);
  if (env.SOURCE_DATABASE_URL === env.DESTINATION_DATABASE_URL) {
    throw new Error("Source and destination database URLs must be different.");
  }
}

// A stable, namespaced ID makes an interrupted contacts-only run restartable.
export function migratedContactId(sourceTenant, sourceContactId) {
  const digest = createHash("sha256").update(`${sourceTenant}:${sourceContactId}`).digest("hex").slice(0, 24);
  return `MIGC_${digest}`;
}

export function migratedLeadId(sourceTenant, sourceLeadId) {
  const digest = createHash("sha256").update(`${sourceTenant}:${sourceLeadId}`).digest("hex").slice(0, 24);
  return `MIGL_${digest}`;
}

export function migratedGroupId(sourceTenant, sourceGroupId) {
  return `MIGG_${createHash("sha256").update(`${sourceTenant}:${sourceGroupId}`).digest("hex").slice(0, 24)}`;
}

export function createConnections(env = process.env) {
  // These are independent clients; never substitute the normal backend db singleton.
  const sourceDb = new Sequelize(env.SOURCE_DATABASE_URL, { dialect: "mysql", logging: false });
  const destinationDb = new Sequelize(env.DESTINATION_DATABASE_URL, { dialect: "mysql", logging: false });
  return { sourceDb, destinationDb };
}

async function oneTenant(db, tenantId, label) {
  const rows = await db.query(
    "SELECT tenant_id FROM tenants WHERE tenant_id = :tenantId AND is_deleted = false",
    { replacements: { tenantId }, type: Sequelize.QueryTypes.SELECT },
  );
  if (rows.length !== 1) throw new Error(`${label} tenant ${tenantId} must resolve to exactly one non-deleted tenant; found ${rows.length}.`);
}

export async function dryRun({ sourceDb, destinationDb, sourceTenant, targetTenant }) {
  await Promise.all([sourceDb.authenticate(), destinationDb.authenticate()]);
  await Promise.all([
    oneTenant(sourceDb, sourceTenant, "Source"),
    oneTenant(destinationDb, targetTenant, "Destination"),
  ]);
  const report = await migrateContacts({ sourceDb, destinationDb, sourceTenant, targetTenant, apply: false });
  const messageReport = await migrateMessages({ sourceDb, destinationDb, sourceTenant, targetTenant, apply: false });
  const leadReport = await migrateLeads({ sourceDb, destinationDb, sourceTenant, targetTenant, apply: false });
  const scoreHistoryReport = await migrateLeadScoreHistory({ sourceDb, destinationDb, sourceTenant, targetTenant, apply: false });
  const groupReport = await migrateContactGroups({ sourceDb, destinationDb, sourceTenant, targetTenant, apply: false });
  const liveChatReport = await migrateLiveChats({ sourceDb, destinationDb, sourceTenant, targetTenant, apply: false });
  const understandingReport = await migrateMessageUnderstanding({ sourceDb, destinationDb, sourceTenant, targetTenant, apply: false });
  const healthcareReport = await migrateHealthcare({ sourceDb, destinationDb, sourceTenant, targetTenant, apply: false });
  const campaignReport = await migrateCampaignHistory({ sourceDb, destinationDb, sourceTenant, targetTenant, apply: false });
  const knowledgeReport = await migrateKnowledge({ sourceDb, destinationDb, sourceTenant, targetTenant, apply: false });
  console.log(`Dry run passed: source ${sourceTenant} -> destination ${targetTenant}.`);
  console.log(`Contacts: ${report.ready.length} ready, ${report.existing.length} already migrated, ${report.conflicts.length} blocking conflicts.`);
  console.log(`Messages: ${messageReport.ready.length} ready, ${messageReport.existing.length} already migrated, ${messageReport.conflicts.length} blocking conflicts.`);
  console.log(`Leads: ${leadReport.ready.length} ready, ${leadReport.existing.length} already migrated, ${leadReport.conflicts.length} blocking conflicts.`);
  console.log(`Lead score history: ${scoreHistoryReport.ready.length} ready, ${scoreHistoryReport.existing.length} already migrated, ${scoreHistoryReport.conflicts.length} blocking conflicts.`);
  console.log(`Contact groups: ${groupReport.ready.length} ready, ${groupReport.existing.length} already migrated, ${groupReport.conflicts.length} blocking conflicts.`);
  console.log(`Live chats: ${liveChatReport.ready.length} ready, ${liveChatReport.existing.length} already migrated, ${liveChatReport.conflicts.length} blocking conflicts.`);
  console.log(`Message understanding: ${understandingReport.ready.length} ready, ${understandingReport.existing.length} already migrated, ${understandingReport.conflicts.length} blocking conflicts.`);
  console.log(`Healthcare: ${healthcareReport.ready.map(rows => rows.length).join("/")} ready, ${healthcareReport.existing.map(rows => rows.length).join("/")} already migrated, ${healthcareReport.conflicts.length} blocking conflicts.`);
  console.log(`Campaign history: ${campaignReport.ready.map(rows => rows.length).join("/")} ready, ${campaignReport.existing.map(rows => rows.length).join("/")} already migrated, ${campaignReport.conflicts.length} blocking conflicts.`);
  console.log(`Knowledge: ${knowledgeReport.ready.map(rows => rows.length).join("/")} ready, ${knowledgeReport.existing.map(rows => rows.length).join("/")} already migrated, ${knowledgeReport.conflicts.length} blocking conflicts.`);
  console.log("No rows were written. Source access must be enforced with a SELECT-only database user.");
  if (report.conflicts.length || messageReport.conflicts.length || leadReport.conflicts.length || scoreHistoryReport.conflicts.length || groupReport.conflicts.length || liveChatReport.conflicts.length || understandingReport.conflicts.length || healthcareReport.conflicts.length || campaignReport.conflicts.length || knowledgeReport.conflicts.length) {
    throw new Error(`Resolve ${report.conflicts.length + messageReport.conflicts.length + leadReport.conflicts.length + scoreHistoryReport.conflicts.length + groupReport.conflicts.length + liveChatReport.conflicts.length + understandingReport.conflicts.length + healthcareReport.conflicts.length + campaignReport.conflicts.length + knowledgeReport.conflicts.length} migration conflict(s) before --apply.`);
  }
}

const CONTACT_COLUMNS = [
  "country_code", "phone", "wa_id", "name", "email", "age", "profile_pic",
  "is_ai_silenced", "is_blocked", "last_message_at", "is_deleted", "deleted_at", "created_at", "updated_at",
];

export async function migrateContacts({ sourceDb, destinationDb, sourceTenant, targetTenant, apply }) {
  const sourceContacts = await sourceDb.query(
    `SELECT contact_id, ${CONTACT_COLUMNS.map(c => `\`${c}\``).join(", ")} FROM contacts WHERE tenant_id = :sourceTenant ORDER BY id`,
    { replacements: { sourceTenant }, type: Sequelize.QueryTypes.SELECT },
  );
  const ids = new Set();
  const conflicts = [];
  for (const contact of sourceContacts) {
    if (!contact.contact_id || !contact.phone || ids.has(contact.contact_id)) {
      conflicts.push({ source_contact_id: contact.contact_id || null, reason: "missing or duplicate source contact_id/phone" });
      continue;
    }
    ids.add(contact.contact_id);
  }
  if (conflicts.length) return { ready: [], existing: [], conflicts };

  const mapped = sourceContacts.map(contact => ({ ...contact, mapped_contact_id: migratedContactId(sourceTenant, contact.contact_id) }));
  const destinationContacts = await destinationDb.query(
    `SELECT contact_id, country_code, phone FROM contacts
     WHERE tenant_id = :targetTenant`,
    {
      replacements: { targetTenant },
      type: Sequelize.QueryTypes.SELECT,
    },
  );
  const byId = new Map(destinationContacts.map(c => [c.contact_id, c]));
  const byPhone = new Map(destinationContacts.map(c => [`${c.country_code}:${c.phone}`, c]));
  const ready = [];
  const existing = [];
  for (const contact of mapped) {
    const phoneKey = `${contact.country_code || "+91"}:${contact.phone}`;
    const sameId = byId.get(contact.mapped_contact_id);
    const samePhone = byPhone.get(phoneKey);
    if (samePhone && samePhone.contact_id !== contact.mapped_contact_id) {
      conflicts.push({ source_contact_id: contact.contact_id, reason: `destination already has phone ${phoneKey} as ${samePhone.contact_id}` });
    } else if (sameId) {
      existing.push(contact);
    } else {
      ready.push(contact);
    }
  }
  if (!apply || conflicts.length) return { ready, existing, conflicts };

  await destinationDb.transaction(async transaction => {
    for (const contact of ready) {
      const columns = ["contact_id", "tenant_id", ...CONTACT_COLUMNS];
      const values = {
        contact_id: contact.mapped_contact_id,
        tenant_id: targetTenant,
        ...Object.fromEntries(CONTACT_COLUMNS.map(column => [column, contact[column] ?? null])),
      };
      // Destination defaults do not run for explicitly-null non-nullable legacy fields.
      if (!values.country_code) values.country_code = "+91";
      if (values.is_ai_silenced == null) values.is_ai_silenced = false;
      if (values.is_blocked == null) values.is_blocked = false;
      if (values.is_deleted == null) values.is_deleted = false;
      await destinationDb.query(
        `INSERT INTO contacts (${columns.map(c => `\`${c}\``).join(", ")}) VALUES (${columns.map(c => `:${c}`).join(", ")})`,
        { replacements: values, transaction },
      );
    }
  });
  return { ready, existing, conflicts };
}

const MESSAGE_COLUMNS = [
  "phone_number_id", "wamid", "wa_id", "country_code", "phone", "name", "sender", "sender_id",
  "message_type", "message", "media_url", "media_mime_type", "media_filename", "template_name",
  "interactive_payload", "status", "seen", "is_deleted", "deleted_at", "created_at", "updated_at",
];

export async function migrateMessages({ sourceDb, destinationDb, sourceTenant, targetTenant, apply }) {
  const sourceMessages = await sourceDb.query(
    `SELECT id, contact_id, ${MESSAGE_COLUMNS.map(c => `\`${c}\``).join(", ")} FROM messages WHERE tenant_id = :sourceTenant ORDER BY id`,
    { replacements: { sourceTenant }, type: Sequelize.QueryTypes.SELECT },
  );
  const conflicts = [];
  const wamids = new Set();
  const mapped = [];
  for (const message of sourceMessages) {
    if (!message.wamid) {
      conflicts.push({ source_message_id: message.id, reason: "missing wamid; no restart-safe message identity" });
      continue;
    }
    if (wamids.has(message.wamid)) {
      conflicts.push({ source_message_id: message.id, reason: `duplicate source wamid ${message.wamid}` });
      continue;
    }
    wamids.add(message.wamid);
    mapped.push({ ...message, mapped_contact_id: migratedContactId(sourceTenant, message.contact_id) });
  }
  const destinationContacts = await destinationDb.query(
    "SELECT contact_id FROM contacts WHERE tenant_id = :targetTenant AND contact_id IN (:contactIds)",
    { replacements: { targetTenant, contactIds: mapped.map(m => m.mapped_contact_id) }, type: Sequelize.QueryTypes.SELECT },
  );
  const targetContactIds = new Set(destinationContacts.map(contact => contact.contact_id));
  const destinationMessages = await destinationDb.query(
    "SELECT wamid, tenant_id, contact_id FROM messages WHERE wamid IN (:wamids)",
    { replacements: { wamids: mapped.map(message => message.wamid) }, type: Sequelize.QueryTypes.SELECT },
  );
  const byWamid = new Map(destinationMessages.map(message => [message.wamid, message]));
  const ready = [];
  const existing = [];
  for (const message of mapped) {
    if (!targetContactIds.has(message.mapped_contact_id)) {
      conflicts.push({ source_message_id: message.id, reason: `missing mapped contact ${message.mapped_contact_id}` });
      continue;
    }
    const existingMessage = byWamid.get(message.wamid);
    if (!existingMessage) ready.push(message);
    else if (existingMessage.tenant_id === targetTenant && existingMessage.contact_id === message.mapped_contact_id) existing.push(message);
    else conflicts.push({ source_message_id: message.id, reason: `wamid already belongs to ${existingMessage.tenant_id}/${existingMessage.contact_id}` });
  }
  if (!apply || conflicts.length) return { ready, existing, conflicts };

  await destinationDb.transaction(async transaction => {
    for (const message of ready) {
      const columns = ["tenant_id", "contact_id", ...MESSAGE_COLUMNS];
      const values = {
        tenant_id: targetTenant,
        contact_id: message.mapped_contact_id,
        ...Object.fromEntries(MESSAGE_COLUMNS.map(column => [column, message[column] ?? null])),
      };
      if (!values.country_code) values.country_code = "+91";
      if (values.seen == null) values.seen = false;
      if (values.is_deleted == null) values.is_deleted = false;
      await destinationDb.query(
        `INSERT INTO messages (${columns.map(c => `\`${c}\``).join(", ")}) VALUES (${columns.map(c => `:${c}`).join(", ")})`,
        { replacements: values, transaction },
      );
    }
  });
  return { ready, existing, conflicts };
}

const LEAD_COLUMNS = [
  "score", "lead_status_final", "ai_summary", "summary_status", "ai_summary_created_at", "last_user_message_at",
  "last_admin_reply_at", "status", "lead_stage", "source", "priority", "internal_notes", "is_deleted", "deleted_at",
  "created_at", "updated_at",
];

export async function migrateLeads({ sourceDb, destinationDb, sourceTenant, targetTenant, apply }) {
  const sourceLeads = await sourceDb.query(
    `SELECT lead_id, contact_id, ${LEAD_COLUMNS.map(c => `\`${c}\``).join(", ")} FROM leads WHERE tenant_id = :sourceTenant ORDER BY id`,
    { replacements: { sourceTenant }, type: Sequelize.QueryTypes.SELECT },
  );
  const conflicts = [];
  const ids = new Set();
  const mapped = [];
  for (const lead of sourceLeads) {
    if (!lead.lead_id || !lead.contact_id || ids.has(lead.lead_id)) {
      conflicts.push({ source_lead_id: lead.lead_id || null, reason: "missing or duplicate source lead_id/contact_id" });
      continue;
    }
    ids.add(lead.lead_id);
    mapped.push({ ...lead, mapped_lead_id: migratedLeadId(sourceTenant, lead.lead_id), mapped_contact_id: migratedContactId(sourceTenant, lead.contact_id) });
  }
  const [destinationContacts, destinationLeads] = await Promise.all([
    destinationDb.query("SELECT contact_id FROM contacts WHERE tenant_id = :targetTenant AND contact_id IN (:contactIds)", {
      replacements: { targetTenant, contactIds: mapped.map(lead => lead.mapped_contact_id) }, type: Sequelize.QueryTypes.SELECT,
    }),
    destinationDb.query("SELECT lead_id, tenant_id FROM leads WHERE lead_id IN (:leadIds)", {
      replacements: { leadIds: mapped.map(lead => lead.mapped_lead_id) }, type: Sequelize.QueryTypes.SELECT,
    }),
  ]);
  const targetContactIds = new Set(destinationContacts.map(contact => contact.contact_id));
  const existingLeads = new Map(destinationLeads.map(lead => [lead.lead_id, lead]));
  const ready = [];
  const existing = [];
  for (const lead of mapped) {
    if (!targetContactIds.has(lead.mapped_contact_id)) {
      conflicts.push({ source_lead_id: lead.lead_id, reason: `missing mapped contact ${lead.mapped_contact_id}` });
    } else if (!existingLeads.has(lead.mapped_lead_id)) {
      ready.push(lead);
    } else if (existingLeads.get(lead.mapped_lead_id).tenant_id === targetTenant) {
      existing.push(lead);
    } else {
      conflicts.push({ source_lead_id: lead.lead_id, reason: `lead ID already belongs to ${existingLeads.get(lead.mapped_lead_id).tenant_id}` });
    }
  }
  if (!apply || conflicts.length) return { ready, existing, conflicts };

  await destinationDb.transaction(async transaction => {
    for (const lead of ready) {
      const columns = ["lead_id", "tenant_id", "contact_id", ...LEAD_COLUMNS];
      const values = {
        lead_id: lead.mapped_lead_id,
        tenant_id: targetTenant,
        contact_id: lead.mapped_contact_id,
        ...Object.fromEntries(LEAD_COLUMNS.map(column => [column, lead[column] ?? null])),
      };
      if (values.score == null) values.score = 0;
      if (!values.lead_status_final) values.lead_status_final = "cold";
      if (!values.summary_status) values.summary_status = "new";
      if (!values.status) values.status = "active";
      if (!values.lead_stage) values.lead_stage = "New";
      if (!values.source) values.source = "none";
      if (!values.priority) values.priority = "Medium";
      if (values.is_deleted == null) values.is_deleted = false;
      // assigned_to is intentionally omitted: old tenant users are not migrated.
      await destinationDb.query(
        `INSERT INTO leads (${columns.map(c => `\`${c}\``).join(", ")}) VALUES (${columns.map(c => `:${c}`).join(", ")})`,
        { replacements: values, transaction },
      );
    }
  });
  return { ready, existing, conflicts };
}

const LEAD_SCORE_HISTORY_COLUMNS = [
  "previous_final_score", "raw_score", "recency_component", "intent_component", "conversation_component",
  "intent_interest_component", "confidence", "final_score", "final_status", "reason_codes", "source_event",
  "created_at", "updated_at",
];

async function bulkInsert(destinationDb, table, rows, transaction) {
  for (let offset = 0; offset < rows.length; offset += 250) {
    await destinationDb.getQueryInterface().bulkInsert(table, rows.slice(offset, offset + 250), { transaction });
  }
}

export async function migrateLeadScoreHistory({ sourceDb, destinationDb, sourceTenant, targetTenant, apply }) {
  const sourceRows = await sourceDb.query(
    `SELECT id, lead_id, contact_id, ${LEAD_SCORE_HISTORY_COLUMNS.map(c => `\`${c}\``).join(", ")}
     FROM lead_score_history WHERE tenant_id = :sourceTenant ORDER BY id`,
    { replacements: { sourceTenant }, type: Sequelize.QueryTypes.SELECT },
  );
  const destinationCountRows = await destinationDb.query(
    "SELECT COUNT(*) AS count FROM lead_score_history WHERE tenant_id = :targetTenant",
    { replacements: { targetTenant }, type: Sequelize.QueryTypes.SELECT },
  );
  const destinationCount = Number(destinationCountRows[0]?.count || 0);
  const conflicts = [];
  if (destinationCount && destinationCount !== sourceRows.length) {
    conflicts.push({ reason: `destination has ${destinationCount} lead_score_history rows; expected 0 or ${sourceRows.length}` });
  }
  const mapped = sourceRows.map(row => ({
    ...row,
    mapped_lead_id: migratedLeadId(sourceTenant, row.lead_id),
    mapped_contact_id: migratedContactId(sourceTenant, row.contact_id),
  }));
  const [destinationLeads, destinationContacts] = await Promise.all([
    destinationDb.query("SELECT lead_id FROM leads WHERE tenant_id = :targetTenant AND lead_id IN (:leadIds)", {
      replacements: { targetTenant, leadIds: mapped.map(row => row.mapped_lead_id) }, type: Sequelize.QueryTypes.SELECT,
    }),
    destinationDb.query("SELECT contact_id FROM contacts WHERE tenant_id = :targetTenant AND contact_id IN (:contactIds)", {
      replacements: { targetTenant, contactIds: mapped.map(row => row.mapped_contact_id) }, type: Sequelize.QueryTypes.SELECT,
    }),
  ]);
  const leadIds = new Set(destinationLeads.map(row => row.lead_id));
  const contactIds = new Set(destinationContacts.map(row => row.contact_id));
  for (const row of mapped) {
    if (!leadIds.has(row.mapped_lead_id) || !contactIds.has(row.mapped_contact_id)) {
      conflicts.push({ source_history_id: row.id, reason: "missing mapped lead or contact" });
    }
  }
  const existing = destinationCount === sourceRows.length ? mapped : [];
  const ready = destinationCount === 0 ? mapped : [];
  if (!apply || conflicts.length || existing.length) return { ready, existing, conflicts };

  const rows = ready.map(row => ({
    tenant_id: targetTenant,
    lead_id: row.mapped_lead_id,
    contact_id: row.mapped_contact_id,
    ...Object.fromEntries(LEAD_SCORE_HISTORY_COLUMNS.map(column => [column, row[column] ?? null])),
  }));
  await destinationDb.transaction(transaction => bulkInsert(destinationDb, "lead_score_history", rows, transaction));
  return { ready, existing, conflicts };
}

export async function migrateContactGroups({ sourceDb, destinationDb, sourceTenant, targetTenant, apply }) {
  const sourceGroups = await sourceDb.query(
    "SELECT group_id, group_name, description, is_deleted, deleted_at, created_at, updated_at FROM contact_groups WHERE tenant_id = :sourceTenant ORDER BY id",
    { replacements: { sourceTenant }, type: Sequelize.QueryTypes.SELECT },
  );
  const mapped = sourceGroups.map(group => ({ ...group, mapped_group_id: migratedGroupId(sourceTenant, group.group_id) }));
  const destinationGroups = await destinationDb.query(
    "SELECT group_id, group_name FROM contact_groups WHERE tenant_id = :targetTenant",
    { replacements: { targetTenant }, type: Sequelize.QueryTypes.SELECT },
  );
  const byId = new Map(destinationGroups.map(group => [group.group_id, group]));
  const names = new Set(destinationGroups.map(group => group.group_name));
  const ready = [];
  const existing = [];
  const conflicts = [];
  for (const group of mapped) {
    if (!group.group_id || !group.group_name) conflicts.push({ source_group_id: group.group_id || null, reason: "missing group ID or name" });
    else if (byId.has(group.mapped_group_id)) existing.push(group);
    else if (names.has(group.group_name)) conflicts.push({ source_group_id: group.group_id, reason: `destination already has group name ${group.group_name}` });
    else ready.push(group);
  }
  if (!apply || conflicts.length) return { ready, existing, conflicts };
  await destinationDb.transaction(transaction => bulkInsert(destinationDb, "contact_groups", ready.map(group => ({
    group_id: group.mapped_group_id, tenant_id: targetTenant, group_name: group.group_name, description: group.description,
    is_deleted: group.is_deleted ?? false, deleted_at: group.deleted_at ?? null, created_at: group.created_at, updated_at: group.updated_at,
  })), transaction));
  return { ready, existing, conflicts };
}

export async function migrateLiveChats({ sourceDb, destinationDb, sourceTenant, targetTenant, apply }) {
  const sourceRows = await sourceDb.query(
    "SELECT contact_id, status, last_message_at, is_deleted, deleted_at, created_at, updated_at FROM live_chats WHERE tenant_id = :sourceTenant ORDER BY created_at",
    { replacements: { sourceTenant }, type: Sequelize.QueryTypes.SELECT },
  );
  const mapped = sourceRows.map(row => ({ ...row, mapped_contact_id: migratedContactId(sourceTenant, row.contact_id) }));
  const [contacts, destinationRows] = await Promise.all([
    destinationDb.query("SELECT contact_id FROM contacts WHERE tenant_id = :targetTenant AND contact_id IN (:ids)", { replacements: { targetTenant, ids: mapped.map(row => row.mapped_contact_id) }, type: Sequelize.QueryTypes.SELECT }),
    destinationDb.query("SELECT contact_id FROM live_chats WHERE tenant_id = :targetTenant", { replacements: { targetTenant }, type: Sequelize.QueryTypes.SELECT }),
  ]);
  const contactIds = new Set(contacts.map(row => row.contact_id));
  const existingIds = new Set(destinationRows.map(row => row.contact_id));
  const ready = [], existing = [], conflicts = [];
  for (const row of mapped) {
    if (!contactIds.has(row.mapped_contact_id)) conflicts.push({ reason: `missing mapped contact ${row.mapped_contact_id}` });
    else if (existingIds.has(row.mapped_contact_id)) existing.push(row);
    else ready.push(row);
  }
  if (!apply || conflicts.length) return { ready, existing, conflicts };
  await destinationDb.transaction(transaction => bulkInsert(destinationDb, "live_chats", ready.map(row => ({
    tenant_id: targetTenant, contact_id: row.mapped_contact_id, status: row.status || "active", last_message_at: row.last_message_at,
    assigned_admin_id: null, is_deleted: row.is_deleted ?? false, deleted_at: row.deleted_at ?? null, created_at: row.created_at, updated_at: row.updated_at,
  })), transaction));
  return { ready, existing, conflicts };
}

const UNDERSTANDING_COLUMNS = [
  "source", "summary", "primary_intent", "buying_signal_score", "clarity_score", "conversation_lead_score",
  "intent_interest_score", "timeline_mentioned", "budget_mentioned", "authority_mentioned", "use_case", "timeline",
  "budget", "confidence", "negative_not_interested", "negative_irrelevant", "raw_payload", "created_at", "updated_at",
];

export async function migrateMessageUnderstanding({ sourceDb, destinationDb, sourceTenant, targetTenant, apply }) {
  const sourceRows = await sourceDb.query(
    `SELECT u.id, u.contact_id, u.lead_id, u.message_id, m.wamid, ${UNDERSTANDING_COLUMNS.map(c => `u.\`${c}\``).join(", ")}
     FROM message_understanding u JOIN messages m ON m.id = u.message_id AND m.tenant_id = u.tenant_id
     WHERE u.tenant_id = :sourceTenant ORDER BY u.id`,
    { replacements: { sourceTenant }, type: Sequelize.QueryTypes.SELECT },
  );
  const mapped = sourceRows.map(row => ({
    ...row,
    mapped_contact_id: migratedContactId(sourceTenant, row.contact_id),
    mapped_lead_id: row.lead_id ? migratedLeadId(sourceTenant, row.lead_id) : null,
  }));
  const [contacts, leads, messages] = await Promise.all([
    destinationDb.query("SELECT contact_id FROM contacts WHERE tenant_id = :targetTenant AND contact_id IN (:ids)", { replacements: { targetTenant, ids: mapped.map(row => row.mapped_contact_id) }, type: Sequelize.QueryTypes.SELECT }),
    destinationDb.query("SELECT lead_id FROM leads WHERE tenant_id = :targetTenant AND lead_id IN (:ids)", { replacements: { targetTenant, ids: mapped.filter(row => row.mapped_lead_id).map(row => row.mapped_lead_id) }, type: Sequelize.QueryTypes.SELECT }),
    destinationDb.query("SELECT id, wamid FROM messages WHERE tenant_id = :targetTenant AND wamid IN (:wamids)", { replacements: { targetTenant, wamids: mapped.map(row => row.wamid) }, type: Sequelize.QueryTypes.SELECT }),
  ]);
  const destinationUnderstanding = await destinationDb.query(
    "SELECT message_id FROM message_understanding WHERE tenant_id = :targetTenant",
    { replacements: { targetTenant }, type: Sequelize.QueryTypes.SELECT },
  );
  const contactIds = new Set(contacts.map(row => row.contact_id));
  const leadIds = new Set(leads.map(row => row.lead_id));
  const messageIdsByWamid = new Map(messages.map(row => [row.wamid, row.id]));
  const existingMessageIds = new Set(destinationUnderstanding.map(row => Number(row.message_id)));
  const ready = [], existing = [], conflicts = [];
  for (const row of mapped) {
    const mappedMessageId = messageIdsByWamid.get(row.wamid);
    if (!row.wamid || !mappedMessageId) conflicts.push({ source_understanding_id: row.id, reason: "source wamid is missing from destination" });
    else if (!contactIds.has(row.mapped_contact_id)) conflicts.push({ source_understanding_id: row.id, reason: "missing mapped contact" });
    else if (row.mapped_lead_id && !leadIds.has(row.mapped_lead_id)) conflicts.push({ source_understanding_id: row.id, reason: "missing mapped lead" });
    else if (existingMessageIds.has(Number(mappedMessageId))) existing.push({ ...row, mapped_message_id: mappedMessageId });
    else ready.push({ ...row, mapped_message_id: mappedMessageId });
  }
  if (!apply || conflicts.length) return { ready, existing, conflicts };
  const rows = ready.map(row => ({
    tenant_id: targetTenant, contact_id: row.mapped_contact_id, lead_id: row.mapped_lead_id, message_id: row.mapped_message_id,
    ...Object.fromEntries(UNDERSTANDING_COLUMNS.map(column => [column, row[column] ?? null])),
  }));
  await destinationDb.transaction(transaction => bulkInsert(destinationDb, "message_understanding", rows, transaction));
  return { ready, existing, conflicts };
}

export const HEALTHCARE_TABLE_ORDER = [
  "specializations", "doctors", "doctor_specializations", "doctor_availability",
  "doctor_availability_days", "appointment_slots", "appointments",
];

export function mapHealthcareAppointment(sourceTenant, targetTenant, row) {
  return {
    ...row,
    tenant_id: targetTenant,
    contact_id: migratedContactId(sourceTenant, row.contact_id),
    lead_id: row.lead_id ? migratedLeadId(sourceTenant, row.lead_id) : null,
  };
}

function healthcareReport(sourceRows, destinationRows, key, targetTenant, label) {
  const byKey = new Map(destinationRows.map(row => [key(row), row]));
  const ready = [], existing = [], conflicts = [];
  for (const row of sourceRows) {
    const found = byKey.get(key(row));
    if (!found) ready.push(row);
    else if (found.tenant_id === undefined || found.tenant_id === targetTenant) existing.push(row);
    else conflicts.push({ reason: `${label} ${key(row)} already belongs to ${found.tenant_id}` });
  }
  return { ready, existing, conflicts };
}

export async function migrateHealthcare({ sourceDb, destinationDb, sourceTenant, targetTenant, apply }) {
  const [specializations, doctors, doctorSpecializations, availability, availabilityDays, slots, appointments] = await Promise.all([
    sourceDb.query("SELECT specialization_id, name, description, is_active, is_deleted, deleted_at, created_at, updated_at FROM specializations WHERE tenant_id = :sourceTenant ORDER BY id", { replacements: { sourceTenant }, type: Sequelize.QueryTypes.SELECT }),
    sourceDb.query("SELECT doctor_id, title, name, country_code, mobile, email, bio, profile_pic, experience_years, qualification, status, consultation_duration, appointment_count, is_deleted, deleted_at, created_at, updated_at FROM doctors WHERE tenant_id = :sourceTenant ORDER BY id", { replacements: { sourceTenant }, type: Sequelize.QueryTypes.SELECT }),
    sourceDb.query("SELECT ds.doctor_id, ds.specialization_id FROM doctor_specializations ds JOIN doctors d ON d.doctor_id = ds.doctor_id WHERE d.tenant_id = :sourceTenant ORDER BY ds.id", { replacements: { sourceTenant }, type: Sequelize.QueryTypes.SELECT }),
    sourceDb.query("SELECT doctor_id, day_of_week, start_time, end_time, created_at, updated_at FROM doctor_availability WHERE tenant_id = :sourceTenant ORDER BY id", { replacements: { sourceTenant }, type: Sequelize.QueryTypes.SELECT }),
    sourceDb.query("SELECT doctor_id, day_of_week, enabled, slot_duration, use_default_duration, created_at, updated_at FROM doctor_availability_days WHERE tenant_id = :sourceTenant ORDER BY id", { replacements: { sourceTenant }, type: Sequelize.QueryTypes.SELECT }),
    sourceDb.query("SELECT doctor_id, appointment_date, appointment_time, status, locked_by_session_id, locked_until, appointment_id, created_at, updated_at FROM appointment_slots WHERE tenant_id = :sourceTenant ORDER BY id", { replacements: { sourceTenant }, type: Sequelize.QueryTypes.SELECT }),
    sourceDb.query("SELECT appointment_id, doctor_id, contact_id, lead_id, patient_name, country_code, contact_number, age, email, appointment_date, appointment_time, status, branch_name, service_name, slot_id, cancelled_at, cancelled_by, token_number, is_reminder_sent, is_feedback_requested, notes, is_deleted, deleted_at, created_at, updated_at FROM appointments WHERE tenant_id = :sourceTenant ORDER BY id", { replacements: { sourceTenant }, type: Sequelize.QueryTypes.SELECT }),
  ]);

  const [targetSpecializations, targetDoctors, targetDoctorSpecializations, targetAvailability, targetAvailabilityDays, targetSlots, targetAppointments, targetContacts, targetLeads] = await Promise.all([
    destinationDb.query("SELECT specialization_id, tenant_id FROM specializations", { type: Sequelize.QueryTypes.SELECT }),
    destinationDb.query("SELECT doctor_id, tenant_id FROM doctors", { type: Sequelize.QueryTypes.SELECT }),
    destinationDb.query("SELECT doctor_id, specialization_id FROM doctor_specializations", { type: Sequelize.QueryTypes.SELECT }),
    destinationDb.query("SELECT doctor_id, tenant_id, day_of_week, start_time FROM doctor_availability", { type: Sequelize.QueryTypes.SELECT }),
    destinationDb.query("SELECT doctor_id, tenant_id, day_of_week FROM doctor_availability_days", { type: Sequelize.QueryTypes.SELECT }),
    destinationDb.query("SELECT doctor_id, tenant_id, appointment_date, appointment_time FROM appointment_slots", { type: Sequelize.QueryTypes.SELECT }),
    destinationDb.query("SELECT appointment_id, tenant_id FROM appointments", { type: Sequelize.QueryTypes.SELECT }),
    destinationDb.query("SELECT contact_id FROM contacts WHERE tenant_id = :targetTenant", { replacements: { targetTenant }, type: Sequelize.QueryTypes.SELECT }),
    destinationDb.query("SELECT lead_id FROM leads WHERE tenant_id = :targetTenant", { replacements: { targetTenant }, type: Sequelize.QueryTypes.SELECT }),
  ]);

  const reports = [
    healthcareReport(specializations, targetSpecializations, row => row.specialization_id, targetTenant, "specialization"),
    healthcareReport(doctors, targetDoctors, row => row.doctor_id, targetTenant, "doctor"),
    healthcareReport(doctorSpecializations, targetDoctorSpecializations, row => `${row.doctor_id}:${row.specialization_id}`, targetTenant, "doctor specialization"),
    healthcareReport(availability, targetAvailability, row => `${row.doctor_id}:${row.day_of_week}:${row.start_time}`, targetTenant, "doctor availability"),
    healthcareReport(availabilityDays, targetAvailabilityDays, row => `${row.doctor_id}:${row.day_of_week}`, targetTenant, "doctor availability day"),
    healthcareReport(slots, targetSlots, row => `${row.doctor_id}:${row.appointment_date}:${row.appointment_time}`, targetTenant, "appointment slot"),
    healthcareReport(appointments, targetAppointments, row => row.appointment_id, targetTenant, "appointment"),
  ];
  const conflicts = reports.flatMap(report => report.conflicts);
  const [specializationReport, doctorReport, doctorSpecializationReport, availabilityReport, availabilityDayReport, slotReport, appointmentReport] = reports;
  const sourceDoctorIds = new Set(doctors.map(row => row.doctor_id));
  const destinationContactIds = new Set(targetContacts.map(row => row.contact_id));
  const destinationLeadIds = new Set(targetLeads.map(row => row.lead_id));
  for (const appointment of appointments) {
    if (appointment.doctor_id && !sourceDoctorIds.has(appointment.doctor_id)) conflicts.push({ reason: `appointment ${appointment.appointment_id} references missing source doctor ${appointment.doctor_id}` });
    if (!destinationContactIds.has(migratedContactId(sourceTenant, appointment.contact_id))) conflicts.push({ reason: `appointment ${appointment.appointment_id} references missing migrated contact` });
    if (appointment.lead_id && !destinationLeadIds.has(migratedLeadId(sourceTenant, appointment.lead_id))) conflicts.push({ reason: `appointment ${appointment.appointment_id} references missing migrated lead` });
    if (appointment.slot_id) conflicts.push({ reason: `appointment ${appointment.appointment_id} has slot_id; slot ID mapping is not implemented` });
  }
  const result = { ready: reports.map(report => report.ready), existing: reports.map(report => report.existing), conflicts };
  if (!apply || conflicts.length) return result;

  await destinationDb.transaction(async transaction => {
    await bulkInsert(destinationDb, "specializations", specializationReport.ready.map(row => ({ ...row, tenant_id: targetTenant })), transaction);
    await bulkInsert(destinationDb, "doctors", doctorReport.ready.map(row => ({ ...row, tenant_id: targetTenant, tenant_user_id: null })), transaction);
    await bulkInsert(destinationDb, "doctor_specializations", doctorSpecializationReport.ready, transaction);
    await bulkInsert(destinationDb, "doctor_availability", availabilityReport.ready.map(row => ({ ...row, tenant_id: targetTenant })), transaction);
    await bulkInsert(destinationDb, "doctor_availability_days", availabilityDayReport.ready.map(row => ({ ...row, tenant_id: targetTenant })), transaction);
    await bulkInsert(destinationDb, "appointment_slots", slotReport.ready.map(row => ({ ...row, tenant_id: targetTenant })), transaction);
    await bulkInsert(destinationDb, "appointments", appointmentReport.ready.map(row => mapHealthcareAppointment(sourceTenant, targetTenant, row)), transaction);
  });
  return result;
}

const CAMPAIGN_COLUMNS = [
  "campaign_name", "campaign_type", "template_id", "status", "total_audience", "delivered_count", "read_count", "replied_count",
  "paused_reason", "pause_type", "pause_code", "paused_at", "header_media_url", "header_file_name", "location_params", "card_media_urls",
  "media_asset_id", "media_handle", "is_deleted", "deleted_at", "created_by", "updated_by", "created_at", "updated_at",
];
const CAMPAIGN_RECIPIENT_COLUMNS = [
  "mobile_number", "status", "meta_message_id", "error_message", "dynamic_variables", "opened_at", "clicked_at", "is_deleted", "deleted_at", "created_at", "updated_at",
];

export function mapCampaignRecipient(sourceTenant, row) {
  return { ...row, contact_id: row.contact_id ? migratedContactId(sourceTenant, row.contact_id) : null };
}

export async function migrateCampaignHistory({ sourceDb, destinationDb, sourceTenant, targetTenant, apply }) {
  const sourceCampaigns = await sourceDb.query(
    `SELECT campaign_id, ${CAMPAIGN_COLUMNS.map(column => `\`${column}\``).join(", ")} FROM whatsapp_campaigns
     WHERE tenant_id = :sourceTenant AND status IN ('completed', 'failed') ORDER BY id`,
    { replacements: { sourceTenant }, type: Sequelize.QueryTypes.SELECT },
  );
  const sourceRecipients = await sourceDb.query(
    `SELECT r.campaign_id, r.contact_id, ${CAMPAIGN_RECIPIENT_COLUMNS.map(column => `r.\`${column}\``).join(", ")}
     FROM whatsapp_campaign_recipients r JOIN whatsapp_campaigns c ON c.campaign_id = r.campaign_id
     WHERE c.tenant_id = :sourceTenant AND c.status IN ('completed', 'failed') ORDER BY r.id`,
    { replacements: { sourceTenant }, type: Sequelize.QueryTypes.SELECT },
  );
  const [destinationCampaigns, destinationRecipients, destinationContacts] = await Promise.all([
    destinationDb.query("SELECT campaign_id, tenant_id FROM whatsapp_campaigns", { type: Sequelize.QueryTypes.SELECT }),
    destinationDb.query("SELECT campaign_id, mobile_number FROM whatsapp_campaign_recipients", { type: Sequelize.QueryTypes.SELECT }),
    destinationDb.query("SELECT contact_id FROM contacts WHERE tenant_id = :targetTenant", { replacements: { targetTenant }, type: Sequelize.QueryTypes.SELECT }),
  ]);
  const campaignReport = healthcareReport(sourceCampaigns, destinationCampaigns, row => row.campaign_id, targetTenant, "campaign");
  const recipientReport = healthcareReport(sourceRecipients, destinationRecipients, row => `${row.campaign_id}:${row.mobile_number}`, targetTenant, "campaign recipient");
  const conflicts = [...campaignReport.conflicts, ...recipientReport.conflicts];
  const destinationContactIds = new Set(destinationContacts.map(row => row.contact_id));
  for (const recipient of sourceRecipients) {
    const mapped = mapCampaignRecipient(sourceTenant, recipient);
    if (mapped.contact_id && !destinationContactIds.has(mapped.contact_id)) {
      conflicts.push({ reason: `campaign recipient ${recipient.campaign_id}/${recipient.mobile_number} references missing migrated contact` });
    }
  }
  const result = { ready: [campaignReport.ready, recipientReport.ready], existing: [campaignReport.existing, recipientReport.existing], conflicts };
  if (!apply || conflicts.length) return result;

  await destinationDb.transaction(async transaction => {
    await bulkInsert(destinationDb, "whatsapp_campaigns", campaignReport.ready.map(row => ({
      campaign_id: row.campaign_id, tenant_id: targetTenant,
      ...Object.fromEntries(CAMPAIGN_COLUMNS.map(column => [column, row[column] ?? null])),
      scheduled_at: null, next_retry_at: null, last_dispatch_enqueued_at: null,
    })), transaction);
    await bulkInsert(destinationDb, "whatsapp_campaign_recipients", recipientReport.ready.map(row => ({
      ...mapCampaignRecipient(sourceTenant, row),
      billing_hold_id: null, authorized_billing_mode: null, authorized_cost_inr: null,
      retry_count: 0, next_retry_at: null, last_error: null,
    })), transaction);
  });
  return result;
}

const KNOWLEDGE_SOURCE_COLUMNS = ["title", "type", "file_name", "source_url", "raw_text", "status", "is_deleted", "deleted_at", "created_at", "updated_at"];
const KNOWLEDGE_CHUNK_COLUMNS = ["chunk_text", "embedding", "is_deleted", "deleted_at", "created_at", "updated_at"];

export function mapKnowledgeChunk(sourceToDestinationIds, targetTenant, row) {
  return {
    tenant_id: targetTenant,
    source_id: sourceToDestinationIds.get(row.source_id),
    ...Object.fromEntries(KNOWLEDGE_CHUNK_COLUMNS.map(column => [column, row[column] ?? null])),
  };
}

export function destinationInsertId(result) {
  if (!Number.isInteger(result) || result < 1) throw new Error("knowledge source insert did not return a destination ID");
  return result;
}

export async function migrateKnowledge({ sourceDb, destinationDb, sourceTenant, targetTenant, apply }) {
  const [sourceRows, sourceChunks] = await Promise.all([
    sourceDb.query(`SELECT id, ${KNOWLEDGE_SOURCE_COLUMNS.map(column => `\`${column}\``).join(", ")} FROM knowledge_sources WHERE tenant_id = :sourceTenant ORDER BY id`, { replacements: { sourceTenant }, type: Sequelize.QueryTypes.SELECT }),
    sourceDb.query(`SELECT source_id, ${KNOWLEDGE_CHUNK_COLUMNS.map(column => `\`${column}\``).join(", ")} FROM knowledge_chunks WHERE tenant_id = :sourceTenant ORDER BY id`, { replacements: { sourceTenant }, type: Sequelize.QueryTypes.SELECT }),
  ]);
  const sourceIds = new Set(sourceRows.map(row => Number(row.id)));
  const conflicts = [];
  for (const chunk of sourceChunks) {
    if (!sourceIds.has(Number(chunk.source_id))) conflicts.push({ reason: `knowledge chunk references missing source ${chunk.source_id}` });
  }
  const [destinationSources, destinationChunks] = await Promise.all([
    destinationDb.query("SELECT COUNT(*) AS count FROM knowledge_sources WHERE tenant_id = :targetTenant", { replacements: { targetTenant }, type: Sequelize.QueryTypes.SELECT }),
    destinationDb.query("SELECT COUNT(*) AS count FROM knowledge_chunks WHERE tenant_id = :targetTenant", { replacements: { targetTenant }, type: Sequelize.QueryTypes.SELECT }),
  ]);
  const destinationSourceCount = Number(destinationSources[0]?.count || 0);
  const destinationChunkCount = Number(destinationChunks[0]?.count || 0);
  const complete = destinationSourceCount === sourceRows.length && destinationChunkCount === sourceChunks.length;
  if (!complete && (destinationSourceCount || destinationChunkCount)) {
    conflicts.push({ reason: `destination has ${destinationSourceCount} knowledge sources and ${destinationChunkCount} chunks; expected both 0 before import` });
  }
  const ready = complete ? [[], []] : [sourceRows, sourceChunks];
  const existing = complete ? [sourceRows, sourceChunks] : [[], []];
  if (!apply || conflicts.length || complete) return { ready, existing, conflicts };

  await destinationDb.transaction(async transaction => {
    const sourceToDestinationIds = new Map();
    for (const source of sourceRows) {
      const values = {
        tenant_id: targetTenant,
        ...Object.fromEntries(KNOWLEDGE_SOURCE_COLUMNS.map(column => [column, source[column] ?? null])),
      };
      if (!values.status) values.status = "inactive";
      if (values.is_deleted == null) values.is_deleted = false;
      const [result] = await destinationDb.query(
        `INSERT INTO knowledge_sources (${["tenant_id", ...KNOWLEDGE_SOURCE_COLUMNS].map(column => `\`${column}\``).join(", ")}) VALUES (${["tenant_id", ...KNOWLEDGE_SOURCE_COLUMNS].map(column => `:${column}`).join(", ")})`,
        { replacements: values, transaction },
      );
      sourceToDestinationIds.set(Number(source.id), destinationInsertId(result));
    }
    await bulkInsert(destinationDb, "knowledge_chunks", sourceChunks.map(chunk => mapKnowledgeChunk(sourceToDestinationIds, targetTenant, chunk)), transaction);
  });
  return { ready, existing, conflicts };
}

async function main() {
  let connections;
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) return console.log(usage);
    validateOptions(options);
    connections = createConnections();
    if (options.mode === "dry-run") await dryRun({ ...connections, ...options });
    else {
      await Promise.all([connections.sourceDb.authenticate(), connections.destinationDb.authenticate()]);
      await Promise.all([
        oneTenant(connections.sourceDb, options.sourceTenant, "Source"),
        oneTenant(connections.destinationDb, options.targetTenant, "Destination"),
      ]);
      const contactReport = await migrateContacts({ ...connections, ...options, apply: false });
      const messageReport = await migrateMessages({ ...connections, ...options, apply: false });
      const leadReport = await migrateLeads({ ...connections, ...options, apply: false });
      const scoreHistoryReport = await migrateLeadScoreHistory({ ...connections, ...options, apply: false });
      const groupReport = await migrateContactGroups({ ...connections, ...options, apply: false });
      const liveChatReport = await migrateLiveChats({ ...connections, ...options, apply: false });
      const understandingReport = await migrateMessageUnderstanding({ ...connections, ...options, apply: false });
      const healthcareReport = await migrateHealthcare({ ...connections, ...options, apply: false });
      const campaignReport = await migrateCampaignHistory({ ...connections, ...options, apply: false });
      const knowledgeReport = await migrateKnowledge({ ...connections, ...options, apply: false });
      if (contactReport.conflicts.length || messageReport.conflicts.length || leadReport.conflicts.length || scoreHistoryReport.conflicts.length || groupReport.conflicts.length || liveChatReport.conflicts.length || understandingReport.conflicts.length || healthcareReport.conflicts.length || campaignReport.conflicts.length || knowledgeReport.conflicts.length) {
        throw new Error(`Resolve ${contactReport.conflicts.length + messageReport.conflicts.length + leadReport.conflicts.length + scoreHistoryReport.conflicts.length + groupReport.conflicts.length + liveChatReport.conflicts.length + understandingReport.conflicts.length + healthcareReport.conflicts.length + campaignReport.conflicts.length + knowledgeReport.conflicts.length} migration conflict(s) before --apply.`);
      }
      const applied = await migrateKnowledge({ ...connections, ...options, apply: true });
      console.log(`Knowledge imported (sources/chunks): ${applied.ready.map(rows => rows.length).join("/")}; already migrated: ${applied.existing.map(rows => rows.length).join("/")}.`);
    }
  } catch (error) {
    console.error(`Migration preflight failed: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await Promise.all([
      connections?.sourceDb?.close(),
      connections?.destinationDb?.close(),
    ]);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
