#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const DEFAULT_CHANGELOG = 'CHANGELOG.md';

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function validateVersion(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version || '')) {
    throw new Error(`Version must be MAJOR.MINOR.PATCH, got: ${version || '(empty)'}`);
  }
}

function validateDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) {
    throw new Error(`Date must be YYYY-MM-DD, got: ${date || '(empty)'}`);
  }
}

function stripMarkdownFence(value) {
  const trimmed = value.replace(/\r\n/g, '\n').trim();
  const fence = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed);
  return fence ? fence[1].trim() : trimmed;
}

export function normalizeChangelogBody(value) {
  let body = stripMarkdownFence(value || '')
    .replace(/[ \t]+$/gm, '')
    .trim();

  if (!body) {
    throw new Error('Changelog notes are empty.');
  }
  if (/^##\s+\[/m.test(body)) {
    throw new Error('Changelog notes must not include the release heading.');
  }

  if (!body.startsWith('### ')) {
    const bulletLines = body.split('\n').map((line) => {
      if (!line.trim() || line.trimStart().startsWith('- ')) return line;
      return `- ${line.trim()}`;
    });
    body = `### Changed\n${bulletLines.join('\n')}`;
  }

  return `${body}\n`;
}

export function buildChangelogSection(version, date, body) {
  validateVersion(version);
  validateDate(date);
  return `## [${version}] - ${date}\n\n${normalizeChangelogBody(body)}`;
}

export function insertChangelogEntry(changelogText, { version, date, body }) {
  validateVersion(version);
  validateDate(date);

  const duplicate = new RegExp(`^## \\[${escapeRegExp(version)}\\] - `, 'm');
  if (duplicate.test(changelogText)) {
    throw new Error(`CHANGELOG.md already contains a ${version} entry.`);
  }

  const section = buildChangelogSection(version, date, body);
  const firstRelease = /^## \[\d+\.\d+\.\d+\] - \d{4}-\d{2}-\d{2}$/m.exec(changelogText);
  if (!firstRelease) {
    return `${changelogText.trimEnd()}\n\n${section}`;
  }

  const before = changelogText.slice(0, firstRelease.index);
  const after = changelogText.slice(firstRelease.index);
  return `${before}${section}\n${after}`;
}

function parseArgs(argv) {
  const args = {
    changelog: DEFAULT_CHANGELOG,
    date: new Date().toISOString().slice(0, 10),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key.startsWith('--')) {
      throw new Error(`Unexpected argument: ${key}`);
    }
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for ${key}`);
    }
    args[key.slice(2).replace(/-/g, '_')] = value;
    i += 1;
  }

  if (!args.version) throw new Error('Missing --version MAJOR.MINOR.PATCH');
  if (!args.notes_file) throw new Error('Missing --notes-file path');
  return args;
}

function runCli() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const changelog = readFileSync(args.changelog, 'utf8');
    const notes = readFileSync(args.notes_file, 'utf8');
    const next = insertChangelogEntry(changelog, {
      version: args.version,
      date: args.date,
      body: notes,
    });
    writeFileSync(args.changelog, next);
    console.log(`Inserted CHANGELOG.md entry for ${args.version}.`);
  } catch (error) {
    console.error(`update-changelog: ${error.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli();
}
