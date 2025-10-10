import { log } from "builder-util"
import * as path from "path"
import * as fs from "fs-extra"
import { createHash } from "crypto"
import { NodeModulesCollector } from "./nodeModulesCollector"
import { PM } from "./packageManager"
import { Dependency } from "./types"

interface BunDependency extends Dependency<BunDependency, BunDependency> {
  reference: string
  manifestDependencies: Record<string, string>
  manifestOptionalDependencies: Record<string, string>
}

export class BunNodeModulesCollector extends NodeModulesCollector<BunDependency, BunDependency> {
  public readonly installOptions = { manager: PM.BUN, lockfile: "bun.lock" }

  private readonly dependencyCacheByPath = new Map<string, BunDependency>()
  private readonly processingPaths = new Set<string>()
  private readonly referenceByPath = new Map<string, string>()
  private readonly pathByNameVersion = new Map<string, string>()

  protected async getDependenciesTree(): Promise<BunDependency> {
    const rootManifest = this.readPackageJson(this.rootDir)
    const rootName = rootManifest.name ?? "."

    const childMaps = await this.resolveChildren(this.rootDir, rootManifest.dependencies ?? {}, rootManifest.optionalDependencies ?? {})
    return {
      name: rootName,
      version: rootManifest.version ?? "0.0.0",
      reference: ".",
      path: this.rootDir,
      manifestDependencies: rootManifest.dependencies ?? {},
      manifestOptionalDependencies: rootManifest.optionalDependencies ?? {},
      dependencies: Object.keys(childMaps.dependencies).length > 0 ? childMaps.dependencies : undefined,
      optionalDependencies: Object.keys(childMaps.optionalDependencies).length > 0 ? childMaps.optionalDependencies : undefined,
    }
  }

  protected getArgs(): string[] {
    return []
  }

  protected collectAllDependencies(tree: BunDependency): void {
    // Collect regular dependencies
    for (const dependency of Object.values(tree.dependencies || {})) {
      const key = `${dependency.name}@${dependency.reference}`
      if (!this.allDependencies.has(key)) {
        this.allDependencies.set(key, dependency)
        this.collectAllDependencies(dependency)
      }
    }

    // Collect optional dependencies
    for (const dependency of Object.values(tree.optionalDependencies || {})) {
      const key = `${dependency.name}@${dependency.reference}`
      if (!this.allDependencies.has(key)) {
        this.allDependencies.set(key, dependency)
        this.collectAllDependencies(dependency)
      }
    }
  }

  protected extractProductionDependencyGraph(tree: BunDependency, dependencyId: string): void {
    if (this.productionGraph[dependencyId]) {
      return
    }

    const dependencies: string[] = []

    const appendChildren = (entries: Record<string, BunDependency> | undefined, manifest: Record<string, string>) => {
      if (!entries) {
        return
      }
      for (const [alias, dep] of Object.entries(entries)) {
        if (!manifest[alias]) {
          continue
        }
        const childId = `${dep.name}@${dep.reference}`
        dependencies.push(childId)
        this.extractProductionDependencyGraph(dep, childId)
      }
    }

    appendChildren(tree.dependencies, tree.manifestDependencies)
    appendChildren(tree.optionalDependencies, tree.manifestOptionalDependencies)

    this.productionGraph[dependencyId] = { dependencies }
  }

  protected parseDependenciesTree(_jsonBlob: string): BunDependency {
    throw new Error("BunNodeModulesCollector does not parse external dependency trees")
  }

  private async resolveChildren(
    requesterDir: string,
    manifestDependencies: Record<string, string>,
    manifestOptionalDependencies: Record<string, string>
  ): Promise<{
    dependencies: Record<string, BunDependency>
    optionalDependencies: Record<string, BunDependency>
  }> {
    const dependencies: Record<string, BunDependency> = {}
    const optionalDependencies: Record<string, BunDependency> = {}

    for (const alias of Object.keys(manifestDependencies)) {
      const dep = await this.loadDependency(alias, requesterDir, false)
      if (dep) {
        dependencies[alias] = dep
      }
    }

    for (const alias of Object.keys(manifestOptionalDependencies)) {
      const dep = await this.loadDependency(alias, requesterDir, true)
      if (dep) {
        optionalDependencies[alias] = dep
      }
    }

    return { dependencies, optionalDependencies }
  }

  private async loadDependency(alias: string, requesterDir: string, isOptional: boolean): Promise<BunDependency | null> {
    const installedPath = await this.findInstalledDependency(requesterDir, alias)
    if (!installedPath) {
      if (!isOptional) {
        log.debug({ alias, requesterDir }, "bun collector could not locate dependency")
      }
      return null
    }

    const realDir = this.resolvePath(installedPath)

    const cached = this.dependencyCacheByPath.get(realDir)
    if (cached) {
      return cached
    }

    if (this.processingPaths.has(realDir)) {
      return this.dependencyCacheByPath.get(realDir) ?? null
    }

    this.processingPaths.add(realDir)

    try {
      const manifest = this.readPackageJson(realDir)
      const packageName = manifest.name ?? alias
      const manifestDependencies = manifest.dependencies ?? {}
      const manifestOptionalDependencies = manifest.optionalDependencies ?? {}
      const childMaps = await this.resolveChildren(realDir, manifestDependencies, manifestOptionalDependencies)
      const reference = this.createReference(packageName, manifest.version, realDir)

      const dependency: BunDependency = {
        name: packageName,
        version: manifest.version ?? "0.0.0",
        reference,
        path: realDir,
        manifestDependencies,
        manifestOptionalDependencies,
        dependencies: Object.keys(childMaps.dependencies).length > 0 ? childMaps.dependencies : undefined,
        optionalDependencies: Object.keys(childMaps.optionalDependencies).length > 0 ? childMaps.optionalDependencies : undefined,
      }

      this.dependencyCacheByPath.set(realDir, dependency)

      return dependency
    } finally {
      this.processingPaths.delete(realDir)
    }
  }

  private async findInstalledDependency(startDir: string, dependencyName: string): Promise<string | null> {
    let currentDir = startDir
    const resolvedRoot = path.resolve(this.rootDir)

    while (true) {
      const candidate = path.join(currentDir, "node_modules", dependencyName)
      if (await fs.pathExists(candidate)) {
        return candidate
      }
      if (path.resolve(currentDir) === resolvedRoot) {
        break
      }
      const parentDir = path.dirname(currentDir)
      if (parentDir === currentDir) {
        break
      }
      currentDir = parentDir
    }

    const rootCandidate = path.join(resolvedRoot, "node_modules", dependencyName)
    if (await fs.pathExists(rootCandidate)) {
      return rootCandidate
    }

    return null
  }

  private createReference(name: string, version: string | undefined, realDir: string): string {
    const cachedReference = this.referenceByPath.get(realDir)
    if (cachedReference) {
      return cachedReference
    }

    const normalizedVersion = version ?? "0.0.0"
    const key = `${name}@${normalizedVersion}`
    const existingPath = this.pathByNameVersion.get(key)

    if (!existingPath) {
      this.pathByNameVersion.set(key, realDir)
      this.referenceByPath.set(realDir, normalizedVersion)
      return normalizedVersion
    }

    if (existingPath === realDir) {
      this.referenceByPath.set(realDir, normalizedVersion)
      return normalizedVersion
    }

    const hash = createHash("sha1").update(realDir).digest("hex").slice(0, 8)
    const uniqueReference = `${normalizedVersion}+${hash}`
    this.referenceByPath.set(realDir, uniqueReference)
    return uniqueReference
  }

  private readPackageJson(dir: string): any {
    const packageJsonPath = path.join(dir, "package.json")
    try {
      return require(packageJsonPath)
    } catch (error: any) {
      throw new Error(`Unable to read package.json for ${dir}: ${error?.message ?? error}`)
    }
  }
}
