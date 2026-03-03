/**
 * Pure utility functions for IM slash commands.
 * Extracted from index.ts to enable unit testing without DB/state dependencies.
 */

// ─── Types ──────────────────────────────────────────────────────

export interface AgentInfo {
  id: string;
  name: string;
  status: string;
}

export interface WorkspaceInfo {
  folder: string;
  name: string;
  agents: AgentInfo[];
}

export interface SwitchResult {
  folder: string;
  agentId: string | null;
  /** Human-readable label, e.g. "前端项目 / 主对话" */
  label: string;
}

export interface MessageForContext {
  sender: string;
  sender_name: string;
  content: string;
  is_from_me: boolean;
}

// ─── Switch Resolution ──────────────────────────────────────────

/**
 * Resolve a /switch target string to a folder + agentId.
 *
 * Priority order:
 *   1. "主对话" / "main" → main conversation of current folder
 *   2. Agent name/id in current folder
 *   3. Workspace folder/name match → its main conversation
 *   4. Agent name across all workspaces
 *
 * Returns null if no match found.
 */
export function resolveSwitch(
  target: string,
  currentFolder: string,
  workspaces: WorkspaceInfo[],
): SwitchResult | null {
  const t = target.toLowerCase();

  // Find the display name for a folder
  const folderName = (folder: string): string => {
    const ws = workspaces.find((w) => w.folder === folder);
    return ws?.name ?? folder;
  };

  // Find the current workspace
  const currentWs = workspaces.find((w) => w.folder === currentFolder);

  // 1. "主对话" / "main" → stay in current folder, switch to main
  if (t === '主对话' || t === 'main') {
    return {
      folder: currentFolder,
      agentId: null,
      label: `${folderName(currentFolder)} / 主对话`,
    };
  }

  // Helper: exact or prefix match for agent
  const agentExact = (a: AgentInfo) =>
    a.name.toLowerCase() === t || a.id === target || a.id.startsWith(t);
  const agentPrefix = (a: AgentInfo) =>
    a.name.toLowerCase().startsWith(t);

  // 2. Exact match agent in current folder (by name, full id, or short id prefix)
  if (currentWs) {
    const agent = currentWs.agents.find(agentExact);
    if (agent) {
      return {
        folder: currentFolder,
        agentId: agent.id,
        label: `${currentWs.name} / ${agent.name}`,
      };
    }
  }

  // 3. Exact match workspace by folder or name
  const matchedWs = workspaces.find(
    (w) => w.folder.toLowerCase() === t || w.name.toLowerCase() === t,
  );
  if (matchedWs) {
    return {
      folder: matchedWs.folder,
      agentId: null,
      label: `${matchedWs.name} / 主对话`,
    };
  }

  // 4. Exact match agent across all workspaces (by name or short id prefix)
  for (const ws of workspaces) {
    const agent = ws.agents.find(agentExact);
    if (agent) {
      return {
        folder: ws.folder,
        agentId: agent.id,
        label: `${ws.name} / ${agent.name}`,
      };
    }
  }

  // 5. Prefix match: agent name in current folder
  if (currentWs) {
    const agent = currentWs.agents.find(agentPrefix);
    if (agent) {
      return {
        folder: currentFolder,
        agentId: agent.id,
        label: `${currentWs.name} / ${agent.name}`,
      };
    }
  }

  // 6. Prefix match: workspace name or folder
  const prefixWs = workspaces.find(
    (w) => w.folder.toLowerCase().startsWith(t) || w.name.toLowerCase().startsWith(t),
  );
  if (prefixWs) {
    return {
      folder: prefixWs.folder,
      agentId: null,
      label: `${prefixWs.name} / 主对话`,
    };
  }

  // 7. Prefix match: agent name across all workspaces
  for (const ws of workspaces) {
    const agent = ws.agents.find(agentPrefix);
    if (agent) {
      return {
        folder: ws.folder,
        agentId: agent.id,
        label: `${ws.name} / ${agent.name}`,
      };
    }
  }

  return null;
}

// ─── Context Formatting ─────────────────────────────────────────

/**
 * Format recent messages into a compact context summary.
 * Messages should be in chronological order (oldest first).
 *
 * @param messages  Array of messages (oldest first)
 * @param maxLen    Per-message truncation length
 * @returns         Formatted text block, or empty string if no displayable messages
 */
export function formatContextMessages(
  messages: MessageForContext[],
  maxLen = 80,
): string {
  if (messages.length === 0) return '';

  const lines: string[] = [];
  for (const msg of messages) {
    if (msg.sender === '__system__') continue;

    const who = msg.is_from_me ? '🤖' : `👤${msg.sender_name || ''}`;
    let text = msg.content || '';
    if (text.length > maxLen) text = text.slice(0, maxLen) + '…';
    text = text.replace(/\n/g, ' ');
    lines.push(`  ${who}: ${text}`);
  }

  return lines.length > 0 ? '\n\n📋 最近消息:\n' + lines.join('\n') : '';
}

// ─── List Formatting ────────────────────────────────────────────

/**
 * Format workspace list with current-position markers.
 */
export function formatWorkspaceList(
  workspaces: WorkspaceInfo[],
  currentFolder: string,
  currentAgentId: string | null,
): string {
  if (workspaces.length === 0) return '没有可用的工作区';

  const lines: string[] = ['📂 工作区列表：'];

  // Collect example targets: one by name, one by id
  let exampleName = '';
  let exampleId = '';

  for (const ws of workspaces) {
    const isCurrent = ws.folder === currentFolder;
    const marker = isCurrent ? ' ▶' : '';
    lines.push(`${marker} ${ws.name} (${ws.folder})`);

    const mainMarker = isCurrent && !currentAgentId ? ' ← 当前' : '';
    lines.push(`  · 主对话${mainMarker}`);

    for (const agent of ws.agents) {
      const agentMarker =
        isCurrent && currentAgentId === agent.id ? ' ← 当前' : '';
      const statusIcon = agent.status === 'running' ? '🔄' : '';
      const shortId = agent.id.slice(0, 4);
      lines.push(`  · ${agent.name} [${shortId}] ${statusIcon}${agentMarker}`);

      // Pick a non-current agent for examples
      if (!(isCurrent && currentAgentId === agent.id)) {
        if (!exampleName) exampleName = agent.name;
        if (!exampleId) exampleId = shortId;
      }
    }

    // Pick a non-current workspace name for example
    if (!exampleName && !isCurrent) {
      exampleName = ws.name;
    }
  }

  lines.push('');
  lines.push('💡 使用 /switch <名称或ID> 切换，支持前缀匹配');
  if (exampleName && exampleId) {
    const prefix = exampleName.slice(0, Math.max(3, Math.ceil(exampleName.length / 2)));
    lines.push(`   例: /switch ${exampleName}  或  /switch ${prefix}  或  /switch ${exampleId}`);
  } else if (exampleName) {
    const prefix = exampleName.slice(0, Math.max(3, Math.ceil(exampleName.length / 2)));
    lines.push(`   例: /switch ${exampleName}  或  /switch ${prefix}`);
  }
  return lines.join('\n');
}
