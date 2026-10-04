#!/usr/bin/env node
/**
 * Why a `skill` tool call failed: run the real loader, then read the session log.
 *
 * Nothing about the loader is reimplemented here. The script mounts the real
 * `dsh-skill` registry and the real `dsh-skill-filesystem` provider over this
 * bundle's real `ctx.fs` backend, asks for the catalog with the cwd the log
 * records, and prints both the answer and every path the provider requested —
 * including the ones the fence refused, which is where a silent "no skills"
 * comes from.
 *
 * Usage:
 *   node scripts/inspect-session-skills.mjs <session log> [options]
 *   node scripts/inspect-session-skills.mjs --cwd <execution-world cwd> [options]
 *
 * Options:
 *   --cwd <path>          session cwd to reproduce; default: the log's header
 *   --workspace <dir>     host workspace mounted at /workspace (default: the process cwd)
 *   --dsh-home <dir>      host $DSH_HOME whose skills root is mounted (default: $DSH_HOME or ~/.dsh)
 *   --agents-home <dir>   host user-level agents home (default: $DSH_AGENTS_HOME or ~/.agents)
 *   --name <skill>        name to load after listing (default: the log's first `skill` call)
 *
 * The provider config mirrors this bundle's patch (`dshHome: /`, `agentsHome:
 * /agents`); a deployment that overrides those rows reproduces a different
 * deployment unless the same values are passed here.
 *
 * The log may be plain JSONL or JSONL compressed with zstd (`session.v4.jsonl.zstd`).
 */

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillFilesystem from '@deepseek-ai/dsh-skill-filesystem'
import { WorkspaceFileSystem } from 'dsh-bwrap-sandbox/fs'

const USAGE = 'Usage: node scripts/inspect-session-skills.mjs <session log> [--cwd <path>] [--name <skill>]'
  + ' [--workspace <dir>] [--dsh-home <dir>] [--agents-home <dir>]'

/** Read a session log, decompressing zstd when the file is compressed. */
function readLog(file) {
  if (!file.endsWith('.zstd')) return readFileSync(file, 'utf8')
  const result = spawnSync('zstd', ['-dc', file], { maxBuffer: 1 << 30 })
  if (result.status !== 0) throw new Error(`zstd -dc ${file} failed: ${result.stderr.toString()}`)
  return result.stdout.toString('utf8')
}

/** Joined text of one message's text blocks. */
function textOf(content) {
  if (!Array.isArray(content)) return ''
  return content.filter(block => block?.type === 'text').map(block => block.text).join('\n')
}

/** The skill names one `<available_skills>` reminder lists. */
function catalogNames(text) {
  const block = /<available_skills>([\s\S]*?)<\/available_skills>/.exec(text)
  if (block === null) return undefined
  return [...block[1].matchAll(/-\s+`([^`]+)`/g)].map(match => match[1])
}

/** The facts the session log itself owns. */
function readSession(file) {
  const session = { header: undefined, catalogs: [], skillCalls: [], calls: new Map(), results: new Map() }
  for (const line of readLog(file).split('\n')) {
    if (line.trim().length === 0) continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (event.type === 'session') session.header = event
    if (event.type === 'user/message') {
      const names = catalogNames(textOf(event.data?.content))
      if (names !== undefined) session.catalogs.push({ seq: event.seq, names })
    }
    if (event.type === 'tool/call') {
      session.calls.set(event.data.callId, { callId: event.data.callId, name: event.data.name, args: event.data.arguments, seq: event.seq })
      if (event.data.name === 'skill') session.skillCalls.push({ seq: event.seq, args: event.data.arguments })
    }
    if (event.type === 'tool/result') {
      session.results.set(event.data?.message?.toolCallId, {
        text: textOf(event.data?.message?.content),
        isError: event.data?.message?.isError === true,
      })
    }
  }
  return session
}

/** The name a logged `skill` call asked for. */
function calledName(args) {
  try {
    const parsed = JSON.parse(args)
    return typeof parsed.name === 'string' ? parsed.name : undefined
  } catch {
    return undefined
  }
}

/**
 * Record every path the provider asks the real backend for.
 *
 * The provider's requests are the point of the probe: a refused path reads as
 * absence to the loader, so the loader's own answers never mention it. The three
 * path-taking methods are wrapped on the instance the bundle's own row would
 * have built, leaving service registration and every other method as they are.
 *
 * @param backend - the mounted backend.
 * @returns the array the recorded requests accumulate into.
 */
function recordRequests(backend) {
  const requests = []
  for (const method of ['resolve', 'lstat', 'listDir']) {
    const original = backend[method].bind(backend)
    backend[method] = async (...args) => {
      const path = typeof args[0] === 'string' ? args[0] : String(args[0]?.displayPath ?? args[0])
      try {
        const result = await original(...args)
        requests.push({ method, path, answer: result?.displayPath ?? 'ok', failed: false })
        return result
      } catch (error) {
        requests.push({ method, path, answer: `${String(error.code)}: ${error.message}`, failed: true })
        throw error
      }
    }
  }
  return requests
}

/**
 * Mount the real registry and provider over the real backend and ask for both
 * the catalog and, when a name is known, the exact load the `skill` tool makes.
 */
async function runLoader(options) {
  const context = new Context()
  context.provide('sandboxPolicy', { defaultMode: 'workspace-write' })
  const backend = new WorkspaceFileSystem(context, {
    cwd: options.workspace,
    diffBasisMaxBytes: 10 * 1024 * 1024,
    sessionsRoot: '',
    attachmentsRoot: '',
    spillRoot: '',
    agentsHome: options.agentsHome,
    skillsRoot: join(options.dshHome, 'skills'),
    userInstructionsFile: join(options.dshHome, 'AGENTS.md'),
    additionalReadOnlyRoots: [],
    writableRoots: [],
  })
  const requests = recordRequests(backend)
  try {
    await context.plugin(SkillRegistry)
    await context.plugin(SkillFilesystem, { dshHome: '/', agentsHome: '/agents' })
    const catalog = await context.skills.list({ cwd: options.cwd })
    const loaded = options.name === undefined ? undefined : await context.skills.get(options.name, { cwd: options.cwd })
    return { catalog, loaded, requests }
  } finally {
    await context.fiber.dispose()
  }
}

const argv = process.argv.slice(2)
/** The value after `key`, or undefined. */
const flag = (key) => {
  const index = argv.indexOf(key)
  return index < 0 ? undefined : argv[index + 1]
}
const valued = ['--cwd', '--name', '--workspace', '--dsh-home', '--agents-home']
const positional = argv.filter((value, index) => !value.startsWith('--') && !valued.includes(argv[index - 1] ?? ''))

try {
  const log = positional[0]
  const session = log === undefined
    ? { header: undefined, catalogs: [], skillCalls: [], calls: new Map(), results: new Map() }
    : readSession(log)
  const requested = flag('--name') ?? session.skillCalls.map(call => calledName(call.args)).find(value => value !== undefined)
  const cwd = flag('--cwd') ?? session.header?.cwd
  if (cwd === undefined) {
    console.log(USAGE)
    process.exitCode = 2
  } else {
    const home = homedir()
    const options = {
      cwd,
      name: requested,
      workspace: resolve(flag('--workspace') ?? process.cwd()),
      dshHome: resolve(flag('--dsh-home') ?? process.env.DSH_HOME ?? join(home, '.dsh')),
      agentsHome: resolve(flag('--agents-home') ?? process.env.DSH_AGENTS_HOME ?? join(home, '.agents')),
    }
    console.log(`log          : ${log ?? '(none: --cwd only)'}`)
    if (session.header !== undefined) {
      console.log(`session      : ${session.header.id ?? '?'}  recorded cwd=${session.header.cwd}`)
    }
    console.log(`loader run   : cwd ${options.cwd}`)
    console.log(`               workspace ${options.workspace}  dshHome ${options.dshHome}  agentsHome ${options.agentsHome}`)
    console.log()

    const { catalog, loaded, requests } = await runLoader(options)
    const listed = catalog.length === 0 ? '(none)' : `${catalog.length} skill(s)`
    console.log(`catalog      : ${listed}`)
    for (const skill of catalog) {
      const invocation = skill.invocation.modelInvocable ? 'model' : 'user-only'
      console.log(`  ${skill.name.padEnd(20)} ${skill.source.padEnd(14)} ${invocation.padEnd(9)} ${skill.path ?? '(virtual)'}`)
    }
    console.log()

    const refused = requests.filter(request => request.failed)
    console.log(`requests     : ${requests.length} path(s) asked of ctx.fs, ${refused.length} refused`)
    for (const request of requests) {
      const mark = request.failed ? 'REFUSED' : 'ok     '
      const detail = request.failed ? `  ->  ${request.answer}` : ''
      console.log(`  ${mark} ${request.method.padEnd(7)} ${request.path}${detail}`)
    }
    console.log()

    if (session.catalogs.length > 0) {
      console.log('reminders recorded in this log:')
      for (const entry of session.catalogs) console.log(`  seq ${entry.seq}  ${entry.names.join(', ')}`)
      console.log()
    }
    if (requested !== undefined) {
      const outcome = loaded === undefined
        ? 'undefined — the skill tool answers "unknown or no longer available"'
        : `loaded from ${loaded.path ?? loaded.provider}`
      console.log(`get(${JSON.stringify(requested)}) : ${outcome}`)
    }
    for (const call of session.skillCalls) {
      const callId = [...session.calls.values()].find(item => item.seq === call.seq)?.callId
      const result = session.results.get(callId)
      console.log(`log call     : seq ${call.seq} ${call.args}`)
      if (result !== undefined) {
        console.log(`  result     : ${result.isError ? 'ERROR ' : 'ok    '}${result.text.split('\n')[0]}`)
      }
    }
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('Cannot find package') || message.includes('ERR_MODULE_NOT_FOUND')) {
    console.error('inspect-session-skills: run this from the bundle directory so the harness packages\n'
      + `(@deepseek-ai/dsh-skill, @deepseek-ai/dsh-skill-filesystem) and lib/ resolve: ${message}`)
  } else {
    console.error(`inspect-session-skills: ${message}`)
  }
  process.exitCode = 1
}
