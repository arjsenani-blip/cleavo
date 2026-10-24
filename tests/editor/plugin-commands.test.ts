// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  installPluginRegistry,
  registerPluginDefinition,
  resetPluginRegistryForTests,
  unregisterPlugin,
  pluginCommandIds,
} from '../../src/editor/plugin-registry.js';
import {
  buildRibbonKeymap,
  getRibbonCommand,
  ribbonCommandForKey,
  effectivePluginDefaultKeys,
  commandLabelFor,
  commandAliasesFor,
} from '../../src/editor/ribbon-commands.js';
import { availableRibbonCommandIds } from '../../src/editor/ribbon-availability.js';
import type { CardMirrorPluginApi } from '../../src/editor/plugin-api.js';

const stubApi = {} as CardMirrorPluginApi;

function registerDemo(run: () => void): void {
  installPluginRegistry(() => stubApi);
  registerPluginDefinition({
    id: 'demo',
    name: 'Demo',
    apiVersion: 1,
    commands: [
      { id: 'demo.hello', label: 'Say Hello', keywords: ['greet'], defaultKey: 'Mod-Alt-9', run },
    ],
  });
}

function registerDemoWithKey(defaultKey: string): void {
  installPluginRegistry(() => stubApi);
  registerPluginDefinition({
    id: 'demo',
    name: 'Demo',
    apiVersion: 1,
    commands: [
      { id: 'demo.hello', label: 'Say Hello', keywords: ['greet'], defaultKey, run: () => {} },
    ],
  });
}

afterEach(() => resetPluginRegistryForTests());

describe('plugin commands in the chokepoints', () => {
  it('appear in availableRibbonCommandIds', () => {
    registerDemo(() => {});
    expect(availableRibbonCommandIds()).toContain('demo.hello');
  });
  it('resolve labels and keywords through the fallback helpers', () => {
    registerDemo(() => {});
    expect(commandLabelFor('demo.hello')).toBe('Say Hello');
    expect(commandAliasesFor('demo.hello')).toEqual(['greet']);
    // Static ids keep working through the same helpers.
    expect(typeof commandLabelFor('sendToFlowColumn')).toBe('string');
  });
  it('getRibbonCommand runs the plugin run fn', () => {
    const run = vi.fn();
    registerDemo(run);
    const cmd = getRibbonCommand('demo.hello');
    expect(cmd(null as never, undefined, undefined)).toBe(true);
    expect(run).toHaveBeenCalled();
  });
  it('default keys land in the keymap and reverse-resolve', () => {
    registerDemo(() => {});
    expect(buildRibbonKeymap({})['Mod-Alt-9']).toBeDefined();
    expect(ribbonCommandForKey('Mod-Alt-9')).toBe('demo.hello');
  });
  it('overrides rebind plugin commands', () => {
    registerDemo(() => {});
    const overrides = { 'demo.hello': 'Mod-Alt-8' };
    expect(buildRibbonKeymap(overrides)['Mod-Alt-8']).toBeDefined();
    expect(buildRibbonKeymap(overrides)['Mod-Alt-9']).toBeUndefined();
    expect(ribbonCommandForKey('Mod-Alt-8', overrides)).toBe('demo.hello');
  });
  it('a plugin defaultKey never steals a static DEFAULT key', () => {
    const run = vi.fn();
    installPluginRegistry(() => stubApi);
    registerPluginDefinition({
      id: 'demo',
      name: 'Demo',
      apiVersion: 1,
      // F4 is setPocket's DEFAULT_RIBBON_KEYS binding — the collision case.
      commands: [{ id: 'demo.steal', label: 'Steal F4', defaultKey: 'F4', run }],
    });
    const km = buildRibbonKeymap({});
    expect(km['F4']).toBeDefined();
    // Whatever F4 fires must not be the plugin command: the plugin
    // Command always calls `run` and never throws (runPluginCommand
    // swallows), while the static command may throw on a null state —
    // irrelevant, only "did the plugin run" matters.
    try {
      km['F4']!(null as never, undefined, undefined);
    } catch {
      /* static command touched the (absent) editor state */
    }
    expect(run).not.toHaveBeenCalled();
    expect(ribbonCommandForKey('F4')).toBe('setPocket');
  });
  it('a plugin default differing only in case never steals a static key', () => {
    // toggleReadingMarker's static default is 'Mod-Shift-d'.
    registerDemoWithKey('Mod-Shift-D');
    const map = buildRibbonKeymap({});
    expect(map['Mod-Shift-D']).toBeUndefined();
    expect(ribbonCommandForKey('Mod-Shift-D')).not.toBe('demo.hello');
  });
  it('a suppressed plugin default is not displayed as bound', () => {
    // F4 is setPocket's static default — the plugin default loses.
    registerDemoWithKey('F4');
    expect(effectivePluginDefaultKeys('demo.hello', {})).toEqual([]);
  });
  it('an overridden plugin command displays the override only', () => {
    registerDemoWithKey('Mod-Alt-9');
    expect(effectivePluginDefaultKeys('demo.hello', { 'demo.hello': 'Mod-Alt-8' })).toEqual([
      'Mod-Alt-8',
    ]);
  });
});

describe('plugin-vs-plugin key collisions', () => {
  it('two plugins whose defaults differ only in case bind exactly one command', () => {
    const runA = vi.fn();
    const runB = vi.fn();
    installPluginRegistry(() => stubApi);
    registerPluginDefinition({
      id: 'alpha',
      name: 'Alpha',
      apiVersion: 1,
      commands: [{ id: 'alpha.go', label: 'Go A', defaultKey: 'Mod-Alt-7', run: runA }],
    });
    registerPluginDefinition({
      id: 'beta',
      name: 'Beta',
      apiVersion: 1,
      // Case-only variant of alpha's default: judged on the FOLDED key,
      // so it must lose exactly as it would against a static command.
      commands: [{ id: 'beta.go', label: 'Go B', defaultKey: 'Mod-Alt-Q', run: runB }],
    });
    registerPluginDefinition({
      id: 'gamma',
      name: 'Gamma',
      apiVersion: 1,
      commands: [{ id: 'gamma.go', label: 'Go C', defaultKey: 'Mod-Alt-q', run: vi.fn() }],
    });
    const km = buildRibbonKeymap({});
    // gamma's 'Mod-Alt-q' folds equal to beta's 'Mod-Alt-Q' — only the
    // first-registered binding survives.
    expect(km['Mod-Alt-Q']).toBeDefined();
    expect(km['Mod-Alt-q']).toBeUndefined();
    expect(km['Mod-Alt-7']).toBeDefined();
  });
});

describe('unregisterPlugin (immediate uninstall)', () => {
  it('removes the plugin\'s commands, keys, and rows in one call', () => {
    registerDemoWithKey('Mod-Alt-9');
    expect(buildRibbonKeymap({})['Mod-Alt-9']).toBeDefined();
    const removed = unregisterPlugin('demo');
    expect(removed).toEqual(['demo.hello']);
    expect(pluginCommandIds()).toEqual([]);
    expect(availableRibbonCommandIds()).not.toContain('demo.hello');
    expect(buildRibbonKeymap({})['Mod-Alt-9']).toBeUndefined();
  });

  it('fires the onCommandsChanged hook so live keymaps rebuild', () => {
    const changed: string[] = [];
    installPluginRegistry(() => stubApi, { onCommandsChanged: (id) => changed.push(id) });
    registerPluginDefinition({
      id: 'demo',
      name: 'Demo',
      apiVersion: 1,
      commands: [{ id: 'demo.hello', label: 'Hi', run: () => {} }],
    });
    unregisterPlugin('demo');
    // Direct registerPluginDefinition bypasses the window-global wrapper
    // (which is what fires the hook on REGISTRATION in production);
    // unregisterPlugin fires it itself, which is what this pins.
    expect(changed).toEqual(['demo']);
  });

  it('is a silent no-op for a plugin that never registered', () => {
    expect(unregisterPlugin('ghost')).toEqual([]);
  });
});
