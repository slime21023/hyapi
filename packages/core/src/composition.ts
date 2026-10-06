/** Validates and orders an application's modules and plugins before startup. @module */

import type { Module } from "./types.ts";
import { ConfigurationError } from "./errors.ts";
import { SchemaValidationError, type SchemaValidator } from "./schema.ts";

interface DependencyNode {
  readonly name: string;
  readonly dependencies?: readonly string[];
}

export function sortByDependencies<T extends DependencyNode>(
  items: readonly T[],
  kind: "Module" | "Plugin",
  implicitDependencies: (item: T) => readonly string[] = () => [],
): T[] {
  const byName = new Map<string, T>();
  for (const item of items) {
    if (byName.has(item.name)) {
      throw new ConfigurationError(`${kind} '${item.name}' is already registered.`);
    }
    byName.set(item.name, item);
  }

  for (const item of items) {
    for (const dependency of item.dependencies ?? []) {
      if (!byName.has(dependency)) {
        throw new ConfigurationError(
          `${kind} '${item.name}' requires '${dependency}' to be registered.`,
        );
      }
    }
  }

  const visited = new Set<string>();
  const visiting: string[] = [];
  const sorted: T[] = [];
  const visit = (name: string): void => {
    if (visiting.includes(name)) {
      throw new ConfigurationError(
        `Circular ${kind.toLowerCase()} dependency detected: ${[...visiting, name].join(" -> ")}.`,
      );
    }
    if (visited.has(name)) return;
    const item = byName.get(name)!;
    visiting.push(name);
    for (const dependency of item.dependencies ?? []) visit(dependency);
    for (const dependency of implicitDependencies(item)) visit(dependency);
    visiting.pop();
    visited.add(name);
    sorted.push(item);
  };

  for (const item of items) visit(item.name);
  return sorted;
}

/** Maps each module-provided Port id to its module, rejecting a Port declared twice. */
export function modulePortProviders(modules: readonly Module[]): Map<string, string> {
  const providers = new Map<string, string>();
  for (const module of modules) {
    for (const port of module.provides ?? []) {
      const previous = providers.get(port.id);
      if (previous !== undefined) {
        throw new ConfigurationError(
          `Port '${port.id}' is provided by both '${previous}' and '${module.name}'.`,
        );
      }
      providers.set(port.id, module.name);
    }
  }
  return providers;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** Validates every module's configuration entry before any module or plugin runs setup. */
export function resolveModuleConfigs(
  modules: readonly Module[],
  entries: Readonly<Record<string, unknown>>,
  validator: SchemaValidator,
): Map<Module, unknown> {
  const byName = new Map(modules.map((module) => [module.name, module]));
  for (const name of Object.keys(entries)) {
    const module = byName.get(name);
    if (!module) {
      throw new ConfigurationError(`moduleConfig references unknown module '${name}'.`);
    }
    if (!module.config) {
      throw new ConfigurationError(`Module '${name}' does not declare a configuration schema.`);
    }
  }
  const configs = new Map<Module, unknown>();
  for (const module of modules) {
    if (!module.config) continue;
    const entry = Object.hasOwn(entries, module.name) ? entries[module.name] : {};
    try {
      configs.set(
        module,
        deepFreeze(validator.validateInput(module.config, structuredClone(entry))),
      );
    } catch (error) {
      if (!(error instanceof SchemaValidationError)) throw error;
      throw new ConfigurationError(`Module '${module.name}' configuration is invalid.`, {
        module: module.name,
        errors: error.issues,
      });
    }
  }
  return configs;
}
