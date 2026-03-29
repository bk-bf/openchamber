/**
 * Session actions — SDK-calling operations for session management.
 * Replaces the action methods from the old useSessionStore.
 */

import type { OpencodeClient, Session, Message, Part } from "@opencode-ai/sdk/v2/client"
import { Binary } from "./binary"
import { useSessionUIStore } from "./session-ui-store"
import { applyOptimisticAdd, applyOptimisticRemove, type OptimisticStore } from "./optimistic"
import type { DirectoryStore } from "./child-store"
import type { StoreApi } from "zustand"

// Reference set by SyncProvider — allows actions to access SDK and stores
let _sdk: OpencodeClient | null = null
let _getDirectoryStore: (() => StoreApi<DirectoryStore>) | null = null
let _directory: string = ""

export function setActionRefs(
  sdk: OpencodeClient,
  getStore: () => StoreApi<DirectoryStore>,
  directory: string,
) {
  _sdk = sdk
  _getDirectoryStore = getStore
  _directory = directory
}

function sdk() {
  if (!_sdk) throw new Error("SDK not initialized — is SyncProvider mounted?")
  return _sdk
}

function dirStore() {
  if (!_getDirectoryStore) throw new Error("Directory store not initialized")
  return _getDirectoryStore()
}

function dir() {
  return _directory || undefined
}

// ---------------------------------------------------------------------------
// Session CRUD
// ---------------------------------------------------------------------------

export async function createSession(
  title?: string,
  directoryOverride?: string | null,
  parentID?: string | null,
): Promise<Session | null> {
  try {
    const result = await sdk().session.create({
      directory: directoryOverride ?? _directory,
      title,
      parentID: parentID ?? undefined,
    })
    const session = result.data
    if (!session) return null

    useSessionUIStore.getState().setCurrentSession(session.id)
    useSessionUIStore.getState().markSessionAsOpenChamberCreated(session.id)
    return session
  } catch (error) {
    console.error("[session-actions] createSession failed", error)
    return null
  }
}

/** Optimistically remove a session from the child store list. Returns previous list for rollback. */
function optimisticRemoveSession(sessionId: string): Session[] | null {
  const store = dirStore()
  const current = store.getState()
  const sessions = [...current.session]
  const result = Binary.search(sessions, sessionId, (s) => s.id)
  if (result.found) {
    const snapshot = current.session
    sessions.splice(result.index, 1)
    store.setState({ session: sessions })
    return snapshot
  }
  return null
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function deleteSession(sessionId: string, _options?: Record<string, unknown>): Promise<boolean> {
  // Remove from UI immediately, rollback on error
  const snapshot = optimisticRemoveSession(sessionId)
  const ui = useSessionUIStore.getState()
  if (ui.currentSessionId === sessionId) {
    ui.setCurrentSession(null)
  }
  try {
    await sdk().session.delete({ sessionID: sessionId, directory: dir() })
    return true
  } catch (error) {
    console.error("[session-actions] deleteSession failed", error)
    if (snapshot) dirStore().setState({ session: snapshot })
    return false
  }
}

export async function archiveSession(sessionId: string): Promise<boolean> {
  const snapshot = optimisticRemoveSession(sessionId)
  const ui = useSessionUIStore.getState()
  if (ui.currentSessionId === sessionId) {
    ui.setCurrentSession(null)
  }
  try {
    await sdk().session.update({ sessionID: sessionId, directory: dir(), time: { archived: Date.now() } })
    return true
  } catch (error) {
    console.error("[session-actions] archiveSession failed", error)
    if (snapshot) dirStore().setState({ session: snapshot })
    return false
  }
}

export async function updateSessionTitle(sessionId: string, title: string): Promise<void> {
  await sdk().session.update({ sessionID: sessionId, directory: dir(), title })
}

export async function shareSession(sessionId: string): Promise<Session | null> {
  const result = await sdk().session.share({ sessionID: sessionId, directory: dir() })
  return result.data ?? null
}

export async function unshareSession(sessionId: string): Promise<Session | null> {
  const result = await sdk().session.unshare({ sessionID: sessionId, directory: dir() })
  return result.data ?? null
}

// ---------------------------------------------------------------------------
// Optimistic message send — insert user message before API call, rollback on error
// ---------------------------------------------------------------------------

let messageCounter = 0

function ascendingId(prefix: string): string {
  const now = Date.now()
  const seq = (messageCounter++ % 1000).toString().padStart(3, "0")
  return `${prefix}_${now}${seq}`
}

/**
 * Wraps an async send operation with optimistic user-message insertion.
 * The message + parts appear instantly in the child store. On error they
 * are rolled back and the session status reverts to idle.
 */
export async function optimisticSend(input: {
  sessionId: string
  content: string
  providerID: string
  modelID: string
  agent?: string
  files?: Array<{ type: "file"; mime: string; url: string; filename: string }>
  /** The actual API call to perform after optimistic insert */
  send: () => Promise<void>
}): Promise<void> {
  const store = dirStore()
  const current = store.getState()

  const messageID = ascendingId("message")
  const textPartId = ascendingId("part")

  const msgParts: Array<{ id: string; type: string; text?: string; mime?: string; url?: string; filename?: string }> = [
    { id: textPartId, type: "text" as const, text: input.content },
  ]
  if (input.files) {
    for (const f of input.files) {
      msgParts.push({ id: ascendingId("part"), type: "file" as const, mime: f.mime, url: f.url, filename: f.filename })
    }
  }

  const optimisticMessage = {
    id: messageID,
    role: "user" as const,
    sessionID: input.sessionId,
    parentID: "",
    modelID: input.modelID,
    providerID: input.providerID,
    system: "",
    agent: input.agent ?? "",
    model: `${input.providerID}/${input.modelID}`,
    metadata: {} as Record<string, unknown>,
    time: { created: Date.now(), completed: 0 },
  } as unknown as Message

  const draft: OptimisticStore = {
    message: { ...current.message },
    part: { ...current.part },
  }
  applyOptimisticAdd(draft, {
    sessionID: input.sessionId,
    message: optimisticMessage,
    parts: msgParts.map((p) => ({ ...p } as Part)),
  })

  store.setState({
    session_status: {
      ...current.session_status,
      [input.sessionId]: { type: "busy" as const },
    },
    message: draft.message as Record<string, Message[]>,
    part: draft.part as Record<string, Part[]>,
  })

  try {
    await input.send()
  } catch (error) {
    const s = store.getState()
    const revertDraft: OptimisticStore = {
      message: { ...s.message },
      part: { ...s.part },
    }
    applyOptimisticRemove(revertDraft, {
      sessionID: input.sessionId,
      messageID,
    })
    store.setState({
      session_status: {
        ...s.session_status,
        [input.sessionId]: { type: "idle" as const },
      },
      message: revertDraft.message as Record<string, Message[]>,
      part: revertDraft.part as Record<string, Part[]>,
    })
    throw error
  }
}

// ---------------------------------------------------------------------------
// Abort
// ---------------------------------------------------------------------------

export async function abortCurrentOperation(sessionId: string): Promise<void> {
  try {
    await sdk().session.abort({ sessionID: sessionId, directory: dir() })
  } catch (error) {
    console.error("[session-actions] abort failed", error)
  }
}

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

export async function respondToPermission(
  _sessionId: string,
  requestId: string,
  response: "once" | "always" | "reject",
): Promise<void> {
  await sdk().permission.reply({
    requestID: requestId,
    reply: response,
  })
}

export async function dismissPermission(
  _sessionId: string,
  requestId: string,
): Promise<void> {
  await sdk().permission.reply({
    requestID: requestId,
    reply: "reject",
  })
}

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

export async function respondToQuestion(
  _sessionId: string,
  requestId: string,
  answers: string[] | string[][],
): Promise<void> {
  await sdk().question.reply({
    requestID: requestId,
    answers: answers as Array<Array<string>>,
  })
}

export async function rejectQuestion(
  _sessionId: string,
  requestId: string,
): Promise<void> {
  await sdk().question.reject({
    requestID: requestId,
  })
}

// ---------------------------------------------------------------------------
// Message history
// ---------------------------------------------------------------------------

/**
 * Revert to a specific user message.
 *
 * 1. Abort if session is busy
 * 2. Extract text from the target message for prompt restoration
 * 3. Optimistically set revert marker so messages hide immediately
 * 4. Call SDK session.revert() and merge returned session
 * 5. Set pendingInputText so the reverted message text appears in the input
 */
export async function revertToMessage(sessionId: string, messageId: string): Promise<void> {
  const store = dirStore()
  const state = store.getState()

  // Abort if busy before mutating session state
  const status = state.session_status[sessionId]
  if (status && status.type !== "idle") {
    try {
      await sdk().session.abort({ sessionID: sessionId, directory: dir() })
    } catch {
      // ignore abort errors
    }
  }

  // Extract message text for prompt restoration
  const messages = state.message[sessionId] ?? []
  const targetMsg = messages.find((m) => m.id === messageId)
  let messageText = ""
  if (targetMsg && targetMsg.role === "user") {
    const parts = state.part[messageId] ?? []
    const textParts = parts.filter((p) => p.type === "text")
    messageText = textParts
      .map((p: Record<string, unknown>) => (p as { text?: string }).text || (p as { content?: string }).content || "")
      .join("\n")
      .trim()
  }

  // Optimistically set revert marker — immediately hides reverted messages
  const prevRevert = (() => {
    const s = state.session.find((s) => s.id === sessionId)
    return (s as Session & { revert?: unknown })?.revert
  })()
  const sessions = [...state.session]
  const sessionIdx = sessions.findIndex((s) => s.id === sessionId)
  if (sessionIdx >= 0) {
    sessions[sessionIdx] = { ...sessions[sessionIdx], revert: { messageID: messageId } } as Session
    store.setState({ session: sessions })
  }

  // Restore reverted message text to input
  if (messageText) {
    useSessionUIStore.setState({
      pendingInputText: messageText,
      pendingInputMode: "replace" as const,
    })
  }

  // Call SDK and merge authoritative result into store
  try {
    const result = await sdk().session.revert({ sessionID: sessionId, directory: dir(), messageID: messageId })
    if (result.data) {
      const current = store.getState()
      const updated = [...current.session]
      const idx = updated.findIndex((s) => s.id === sessionId)
      if (idx >= 0) {
        updated[idx] = result.data
        store.setState({ session: updated })
      }
    }
  } catch (err) {
    // Rollback optimistic revert marker on error
    const current = store.getState()
    const rollback = [...current.session]
    const idx = rollback.findIndex((s) => s.id === sessionId)
    if (idx >= 0) {
      rollback[idx] = { ...rollback[idx], revert: prevRevert } as Session
      store.setState({ session: rollback })
    }
    throw err
  }
}

/**
 * Unrevert — restore all previously reverted messages.
 * Restore all previously reverted messages. Aborts if busy, merges result.
 */
export async function unrevertSession(sessionId: string): Promise<void> {
  const store = dirStore()
  const state = store.getState()

  // Abort if busy
  const status = state.session_status[sessionId]
  if (status && status.type !== "idle") {
    try {
      await sdk().session.abort({ sessionID: sessionId, directory: dir() })
    } catch {
      // ignore
    }
  }

  const result = await sdk().session.unrevert({ sessionID: sessionId, directory: dir() })
  if (result.data) {
    const current = store.getState()
    const sessions = [...current.session]
    const idx = sessions.findIndex((s) => s.id === sessionId)
    if (idx >= 0) {
      sessions[idx] = result.data
      store.setState({ session: sessions })
    }
  }
}

/**
 * Fork from a user message.
 *
 * 1. Extract text from the message for input restoration
 * 2. Call SDK session.fork()
 * 3. Insert the new session into the child store (so sidebar updates immediately)
 * 4. Switch to new session and set pending input text
 */
export async function forkFromMessage(sessionId: string, messageId: string): Promise<void> {
  const store = dirStore()
  const state = store.getState()

  // Extract message text for input restoration
  const parts = state.part[messageId] ?? []
  let messageText = ""
  const textParts = parts.filter((p) => p.type === "text")
  messageText = textParts
    .map((p: Part) => ((p as Record<string, unknown>).text as string) || ((p as Record<string, unknown>).content as string) || "")
    .join("\n")
    .trim()

  const result = await sdk().session.fork({ sessionID: sessionId, directory: dir(), messageID: messageId })
  if (!result.data) return

  const forkedSession = result.data

  // Insert new session into child store so sidebar updates immediately
  const current = store.getState()
  const sessions = [...current.session]
  const searchResult = Binary.search(sessions, forkedSession.id, (s) => s.id)
  if (!searchResult.found) {
    sessions.splice(searchResult.index, 0, forkedSession)
    store.setState({ session: sessions })
  }

  // Switch to new session
  useSessionUIStore.getState().setCurrentSession(forkedSession.id)

  // Restore forked message text to input
  if (messageText) {
    useSessionUIStore.setState({
      pendingInputText: messageText,
      pendingInputMode: "replace" as const,
    })
  }
}
