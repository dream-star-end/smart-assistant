import type Docker from 'dockerode'
import { canonicalSha256Hex } from '../connectors/spec/canonical.js'
import type { CompiledLocalPluginBrokerPolicy } from './localBroker.js'
import {
  type LocalPluginRunResult,
  LocalPluginSandboxService,
  type PlatformLocalPluginPackage,
  compilePlatformLocalPluginPackage,
} from './localSandbox.js'
import type { VerifiedRuntimePluginContract } from './review.js'

export interface RegisteredLocalPluginImageV1 {
  imageId: string
  requiredLabels: Readonly<Record<string, string>>
  interpreterVersions: Readonly<Record<string, string>>
}

export const PRODUCTION_LOCAL_PLUGIN_IMAGES: ReadonlyMap<string, RegisteredLocalPluginImageV1> =
  new Map()

export class LocalPluginRuntimeError extends Error {
  readonly code: 'WRONG_PLUGIN_TYPE' | 'RUNTIME_UNAVAILABLE' | 'CONTRACT_DRIFT'

  constructor(code: LocalPluginRuntimeError['code'], message: string = code) {
    super(message)
    this.name = 'LocalPluginRuntimeError'
    this.code = code
  }
}

function equalStringMap(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean {
  const a = Object.entries(left).sort(([x], [y]) => x.localeCompare(y))
  const b = Object.entries(right).sort(([x], [y]) => x.localeCompare(y))
  return JSON.stringify(a) === JSON.stringify(b)
}

export class VerifiedLocalPluginRuntime {
  constructor(
    private readonly docker: Docker,
    private readonly opts: {
      artifactRoot: string
      brokerRoot?: string
      images?: ReadonlyMap<string, RegisteredLocalPluginImageV1>
      expectedArtifactOwnerUid?: number
      expectedBrokerOwnerUid?: number
      brokerSocketUid?: number
      brokerSocketGid?: number
      serviceFactory?: (
        packages: ReadonlyMap<string, PlatformLocalPluginPackage>,
        image: RegisteredLocalPluginImageV1,
        brokerPolicies: ReadonlyMap<string, CompiledLocalPluginBrokerPolicy>,
      ) => Pick<LocalPluginSandboxService, 'runReadAction'>
    },
  ) {}

  async runReadAction(args: {
    verified: VerifiedRuntimePluginContract
    userId: number
    actionId: string
    params: Record<string, unknown>
  }): Promise<LocalPluginRunResult> {
    if (args.verified.pluginType !== 'sandboxed-local')
      throw new LocalPluginRuntimeError('WRONG_PLUGIN_TYPE', 'Plugin is not sandboxed-local')
    const contract = args.verified.contract
    const compiledPackage = args.verified.compiled.localPackage
    const packageSource = {
      manifest: compiledPackage.manifest,
      files: compiledPackage.files,
    }
    const recompiled = compilePlatformLocalPluginPackage(packageSource)
    if (
      recompiled.digest !== contract.runtime.packageDigest ||
      (contract.runtime.brokerPolicy === null) !== (contract.runtime.brokerPolicyHash === null) ||
      (contract.runtime.brokerPolicy !== null &&
        canonicalSha256Hex(contract.runtime.brokerPolicy) !== contract.runtime.brokerPolicyHash)
    )
      throw new LocalPluginRuntimeError('CONTRACT_DRIFT', 'local Plugin package or broker drift')
    const registered = (this.opts.images ?? PRODUCTION_LOCAL_PLUGIN_IMAGES).get(
      contract.runtime.imageId,
    )
    if (
      !registered ||
      registered.imageId !== contract.runtime.imageId ||
      !equalStringMap(registered.requiredLabels, contract.runtime.requiredLabels) ||
      !equalStringMap(registered.interpreterVersions, contract.runtime.interpreterVersions)
    )
      throw new LocalPluginRuntimeError(
        'RUNTIME_UNAVAILABLE',
        'exact local Plugin image/ABI/interpreter runtime is unavailable',
      )

    const packages = new Map<string, PlatformLocalPluginPackage>([[contract.id, packageSource]])
    const brokerPolicies = new Map<string, CompiledLocalPluginBrokerPolicy>()
    if (contract.runtime.brokerPolicy !== null)
      brokerPolicies.set(contract.id, contract.runtime.brokerPolicy)
    const service = this.opts.serviceFactory
      ? this.opts.serviceFactory(packages, registered, brokerPolicies)
      : new LocalPluginSandboxService(this.docker, {
          artifactRoot: this.opts.artifactRoot,
          image: {
            imageId: registered.imageId,
            requiredLabels: registered.requiredLabels,
          },
          packages,
          brokerPolicies,
          ...(this.opts.brokerRoot ? { brokerRoot: this.opts.brokerRoot } : {}),
          ...(this.opts.expectedArtifactOwnerUid !== undefined
            ? { expectedArtifactOwnerUid: this.opts.expectedArtifactOwnerUid }
            : {}),
          ...(this.opts.expectedBrokerOwnerUid !== undefined
            ? { expectedBrokerOwnerUid: this.opts.expectedBrokerOwnerUid }
            : {}),
          ...(this.opts.brokerSocketUid !== undefined
            ? { brokerSocketUid: this.opts.brokerSocketUid }
            : {}),
          ...(this.opts.brokerSocketGid !== undefined
            ? { brokerSocketGid: this.opts.brokerSocketGid }
            : {}),
        })
    return service.runReadAction({
      userId: args.userId,
      pluginId: contract.id,
      actionId: args.actionId,
      params: args.params,
    })
  }
}
