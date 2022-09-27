/*
 * Copyright (C) 2018-2022 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import {
  ProviderHandlers,
  getModuleHandlerDescriptions,
  getProviderActionDescriptions,
  createGardenPlugin,
  ActionHandler,
  ModuleActionHandler,
} from "../../../src/plugin/plugin"
import { ServiceState } from "../../../src/types/service"
import { expectError, makeTestGardenA, stubRouterAction, projectRootA, TestGarden, makeTestGarden } from "../../helpers"
import { ActionRouter } from "../../../src/router/router"
import { LogEntry } from "../../../src/logger/log-entry"
import { GardenModule } from "../../../src/types/module"
import { ServiceLogEntry } from "../../../src/types/service"
import Stream from "ts-stream"
import { expect } from "chai"
import { cloneDeep, omit } from "lodash"
import { CustomObjectSchema, joi, StringMap } from "../../../src/config/common"
import { validateSchema } from "../../../src/config/validation"
import { ProjectConfig, defaultNamespace } from "../../../src/config/project"
import { DEFAULT_API_VERSION } from "../../../src/constants"
import { defaultProvider, providerFromConfig } from "../../../src/config/provider"
import { defaultDotIgnoreFile } from "../../../src/util/fs"
import stripAnsi from "strip-ansi"
import { emptyDir, pathExists, ensureFile, readFile } from "fs-extra"
import { join } from "path"
import { DashboardPage } from "../../../src/plugin/handlers/provider/getDashboardPage"
import { ConfigGraph } from "../../../src/graph/config-graph"
import { BuildActionConfig, ResolvedBuildAction } from "../../../src/actions/build"
import {
  execBuildActionSchema,
  execDeployActionSchema,
  execRunActionSchema,
  execTestActionSchema,
} from "../../../src/plugins/exec/config"
import { convertModules } from "../../../src/resolve-module"
import { actionFromConfig } from "../../../src/graph/actions"
import { TestAction, TestActionConfig } from "../../../src/actions/test"
import { TestConfig } from "../../../src/config/test"
import { findByName } from "../../../src/util/util"
import { ResolvedRunAction, RunActionConfig } from "../../../src/actions/run"
import { DeployActionConfig, ResolvedDeployAction } from "../../../src/actions/deploy"
import { BaseBuildSpec } from "../../../src/config/module"

const now = new Date()

describe("ActionRouter", () => {
  let garden: TestGarden
  let graph: ConfigGraph
  let log: LogEntry
  let actionRouter: ActionRouter
  let module: GardenModule
  let resolvedBuildAction: ResolvedBuildAction
  let resolvedDeployAction: ResolvedDeployAction
  let resolvedRunAction: ResolvedRunAction

  const projectConfig: ProjectConfig = {
    apiVersion: DEFAULT_API_VERSION,
    kind: "Project",
    name: "test",
    path: projectRootA,
    defaultEnvironment: "default",
    dotIgnoreFile: defaultDotIgnoreFile,
    environments: [{ name: "default", defaultNamespace, variables: {} }],
    providers: [{ name: "base" }, { name: "test-plugin" }, { name: "test-plugin-b" }],
    variables: {},
  }

  before(async () => {
    garden = await makeTestGarden(projectRootA, {
      plugins: [basePlugin, testPlugin, testPluginB],
      config: projectConfig,
    })
    projectConfig.path = garden.projectRoot
    log = garden.log
    actionRouter = await garden.getActionRouter()
    graph = await garden.getConfigGraph({ log: garden.log, emit: false })
    module = graph.getModule("module-a")
    const actions = graph.getActions()
    const buildAction = graph.getBuild("build.module-a")
    resolvedBuildAction = await garden.resolveAction({
      action: buildAction,
      log: garden.log,
      graph: await garden.getConfigGraph({ log: garden.log, emit: false }),
    })
    const deployAction = graph.getDeploy("service-a")
    resolvedDeployAction = await garden.resolveAction({
      action: deployAction,
      log: garden.log,
      graph: await garden.getConfigGraph({ log: garden.log, emit: false }),
    })
    const runAction = graph.getRun("task-a")
    resolvedRunAction = await garden.resolveAction({
      action: runAction,
      log: garden.log,
      graph: await garden.getConfigGraph({ log: garden.log, emit: false }),
    })
  })

  after(async () => {
    await garden.close()
  })

  async function executeTestAction(targetModule: GardenModule, testConfig: TestConfig) {
    const testModule = cloneDeep(targetModule)
    testModule.testConfigs.push(testConfig)
    const { actions } = await convertModules(garden, garden.log, [module], graph.moduleGraph)
    const action = (await actionFromConfig({
      garden,
      // rebuild config graph because the module config has been changed
      graph: await garden.getConfigGraph({ emit: false, log: garden.log }),
      config: actions.filter((a) => a.name === testConfig.name)[0],
      log: garden.log,
      configsByKey: {},
      router: await garden.getActionRouter(),
    })) as TestAction
    return await garden.executeAction<TestAction>({ action, log: garden.log })
  }

  // Note: The test plugins below implicitly validate input params for each of the tests
  describe("environment actions", () => {
    describe("configureProvider", () => {
      it.only("should configure the provider", async () => {
        const config = { name: "test-plugin", foo: "bar", dependencies: [] }
        const result = await actionRouter.provider.configureProvider({
          ctx: await garden.getPluginContext(
            providerFromConfig({
              plugin: await garden.getPlugin("test-plugin"),
              config,
              dependencies: {},
              moduleConfigs: [],
              status: { ready: false, outputs: {} },
            })
          ),
          namespace: "default",
          environmentName: "default",
          pluginName: "test-plugin",
          log,
          config,
          configStore: garden.configStore,
          projectName: garden.projectName,
          projectRoot: garden.projectRoot,
          dependencies: {},
        })
        expect(result).to.eql({
          config,
          moduleConfigs: [],
        })
      })
    })

    describe("augmentGraph", () => {
      it("should return modules and/or dependency relations to add to the stack graph", async () => {
        graph = await garden.getConfigGraph({ log: garden.log, emit: false })
        const providers = await garden.resolveProviders(garden.log)
        const result = await actionRouter.provider.augmentGraph({
          log,
          pluginName: "test-plugin",
          actions: graph.getActions(),
          providers,
        })

        const name = "added-by-test-plugin"

        expect(result).to.eql({
          addDependencies: [{ by: name, on: "service-b" }],
          addActions: [
            // {
            //   apiVersion: DEFAULT_API_VERSION,
            //   kind: "Module",
            //   name,
            //   type: "test",
            //   path: garden.projectRoot,
            //   services: [{ name }],
            //   allowPublish: true,
            //   build: { dependencies: [] },
            //   disabled: false,
            //   generateFiles: [],
            // },
          ],
        })
      })
    })

    describe("getDashboardPage", () => {
      it("should resolve the URL for a dashboard page", async () => {
        const page: DashboardPage = {
          name: "foo",
          title: "Foo",
          description: "foodefoodefoo",
          newWindow: false,
        }
        const result = await actionRouter.provider.getDashboardPage({ log, pluginName: "test-plugin", page })
        expect(result).to.eql({
          url: "http://foo",
        })
      })
    })

    describe("getEnvironmentStatus", () => {
      it("should return the environment status for a provider", async () => {
        const result = await actionRouter.provider.getEnvironmentStatus({ log, pluginName: "test-plugin" })
        expect(result).to.eql({
          ready: false,
          outputs: {},
        })
      })
    })

    describe("prepareEnvironment", () => {
      it("should prepare the environment for a configured provider", async () => {
        const result = await actionRouter.provider.prepareEnvironment({
          log,
          pluginName: "test-plugin",
          force: false,
          status: { ready: true, outputs: {} },
        })
        expect(result).to.eql({
          status: {
            ready: true,
            outputs: {},
          },
        })
      })
    })

    describe("cleanupEnvironment", () => {
      it("should clean up environment for a provider", async () => {
        const result = await actionRouter.provider.cleanupEnvironment({ log, pluginName: "test-plugin" })
        expect(result).to.eql({})
      })
    })

    describe("getSecret", () => {
      it("should retrieve a secret from the specified provider", async () => {
        const result = await actionRouter.provider.getSecret({ log, pluginName: "test-plugin", key: "foo" })
        expect(result).to.eql({ value: "foo" })
      })
    })

    describe("setSecret", () => {
      it("should set a secret via the specified provider", async () => {
        const result = await actionRouter.provider.setSecret({
          log,
          pluginName: "test-plugin",
          key: "foo",
          value: "boo",
        })
        expect(result).to.eql({})
      })
    })

    describe("deleteSecret", () => {
      it("should delete a secret from the specified provider", async () => {
        const result = await actionRouter.provider.deleteSecret({ log, pluginName: "test-plugin", key: "foo" })
        expect(result).to.eql({ found: true })
      })
    })
  })

  describe("module actions", () => {
    describe("configureModule", () => {
      it("should consolidate the declared build dependencies", async () => {
        const moduleConfigA = (await garden.getRawModuleConfigs(["module-a"]))[0]

        const moduleConfig = {
          ...moduleConfigA,
          build: {
            dependencies: [
              { name: "module-b", copy: [{ source: "1", target: "1" }] },
              { name: "module-b", copy: [{ source: "2", target: "2" }] },
              { name: "module-b", copy: [{ source: "2", target: "2" }] },
              { name: "module-c", copy: [{ source: "3", target: "3" }] },
            ],
          },
        }

        const result = await actionRouter.module.configureModule({ log, moduleConfig })
        expect(result.moduleConfig.build.dependencies).to.eql([
          {
            name: "module-b",
            copy: [
              { source: "1", target: "1" },
              { source: "2", target: "2" },
            ],
          },
          {
            name: "module-c",
            copy: [{ source: "3", target: "3" }],
          },
        ])
      })
    })

    describe("build.getStatus", () => {
      it("should correctly call the corresponding plugin handler", async () => {
        const result = await actionRouter.build.getStatus({ log, action: resolvedBuildAction, graph })
        expect(result).to.eql({
          ready: true,
        })
      })

      it("should emit a buildStatus event", async () => {
        garden.events.eventLog = []
        await actionRouter.build.getStatus({ log, action: resolvedBuildAction, graph })
        const event = garden.events.eventLog[0]
        expect(event).to.exist
        expect(event.name).to.eql("buildStatus")
        expect(event.payload.moduleName).to.eql("module-a")
        expect(event.payload.moduleVersion).to.eql(module.version.versionString)
        expect(event.payload.actionUid).to.be.undefined
        expect(event.payload.status.state).to.eql("fetched")
      })
    })

    describe("build", () => {
      it("should correctly call the corresponding plugin handler", async () => {
        const result = await actionRouter.build.build({ log, action: resolvedBuildAction, graph })
        expect(result).to.eql({})
      })

      it("should emit buildStatus events", async () => {
        garden.events.eventLog = []
        await actionRouter.build.build({ log, action: resolvedBuildAction, graph })
        const event1 = garden.events.eventLog[0]
        const event2 = garden.events.eventLog[1]
        const moduleVersion = module.version.versionString
        expect(event1).to.exist
        expect(event1.name).to.eql("buildStatus")
        expect(event1.payload.moduleName).to.eql("module-a")
        expect(event1.payload.moduleVersion).to.eql(moduleVersion)
        expect(event1.payload.status.state).to.eql("building")
        expect(event1.payload.actionUid).to.be.ok
        expect(event2).to.exist
        expect(event2.name).to.eql("buildStatus")
        expect(event2.payload.moduleName).to.eql("module-a")
        expect(event2.payload.moduleVersion).to.eql(moduleVersion)
        expect(event2.payload.status.state).to.eql("built")
        expect(event2.payload.actionUid).to.eql(event1.payload.actionUid)
      })
    })

    describe("build.run", () => {
      it("should correctly call the corresponding plugin handler", async () => {
        const command = ["npm", "run"]
        const result = await actionRouter.build.run({
          log,
          action: await garden.executeAction({
            action: resolvedBuildAction,
            log: garden.log,
            graph: await garden.getConfigGraph({ log: garden.log, emit: false }),
          }),
          args: command,
          interactive: true,
          graph,
        })
        expect(result).to.eql({
          moduleName: module.name,
          command,
          completedAt: now,
          log: "bla bla",
          success: true,
          startedAt: now,
          version: module.version.versionString,
        })
      })
    })

    describe("test.run", () => {
      it("should correctly call the corresponding plugin handler", async () => {
        // const test = testFromConfig(
        //   module,
        //   {
        //     name: "test",
        //     dependencies: [],
        //     disabled: false,
        //     timeout: 1234,
        //     spec: {},
        //   },
        //   graph.moduleGraph
        // )
        const action = await executeTestAction(module, {
          name: "test",
          dependencies: [],
          disabled: false,
          timeout: 1234,
          spec: {},
        })
        const result = await actionRouter.test.run({
          log,
          action,
          interactive: true,
          graph,
          silent: false,
        })
        expect(result).to.eql({
          moduleName: module.name,
          command: [],
          completedAt: now,
          log: "bla bla",
          outputs: {
            log: "bla bla",
          },
          success: true,
          startedAt: now,
          testName: "test",
          version: action.versionString(),
        })
      })

      it("should emit testStatus events", async () => {
        garden.events.eventLog = []
        // const test = testFromConfig(
        //   module,
        //   {
        //     name: "test",
        //     dependencies: [],
        //     disabled: false,
        //     timeout: 1234,
        //     spec: {},
        //   },
        //   graph.moduleGraph
        // )
        const action = await executeTestAction(module, {
          name: "test",
          dependencies: [],
          disabled: false,
          timeout: 1234,
          spec: {},
        })
        await actionRouter.test.run({
          log,
          action,
          interactive: true,
          graph,
          silent: false,
        })
        const moduleVersion = module.version.versionString
        const testVersion = action.versionString()
        const event1 = garden.events.eventLog[0]
        const event2 = garden.events.eventLog[1]
        expect(event1).to.exist
        expect(event1.name).to.eql("testStatus")
        expect(event1.payload.testName).to.eql("test")
        expect(event1.payload.moduleName).to.eql("module-a")
        expect(event1.payload.moduleVersion).to.eql(moduleVersion)
        expect(event1.payload.testVersion).to.eql(testVersion)
        expect(event1.payload.actionUid).to.be.ok
        expect(event1.payload.status.state).to.eql("running")
        expect(event2).to.exist
        expect(event2.name).to.eql("testStatus")
        expect(event2.payload.testName).to.eql("test")
        expect(event2.payload.moduleName).to.eql("module-a")
        expect(event2.payload.moduleVersion).to.eql(moduleVersion)
        expect(event2.payload.testVersion).to.eql(testVersion)
        expect(event2.payload.actionUid).to.eql(event1.payload.actionUid)
        expect(event2.payload.status.state).to.eql("succeeded")
      })

      it("should copy artifacts exported by the handler to the artifacts directory", async () => {
        await emptyDir(garden.artifactsPath)

        const testConfig = {
          name: "test",
          dependencies: [],
          disabled: false,
          timeout: 1234,
          spec: {
            artifacts: [
              {
                source: "some-file.txt",
              },
              {
                source: "some-dir/some-file.txt",
                target: "some-dir/some-file.txt",
              },
            ],
          },
        }

        // const test = testFromConfig(module, testConfig, graph.moduleGraph)
        const action = await executeTestAction(module, testConfig)

        await actionRouter.test.run({
          log,
          action,
          interactive: true,
          graph,
          silent: false,
        })

        const targetPaths = testConfig.spec.artifacts.map((spec) => join(garden.artifactsPath, spec.source)).sort()

        for (const path of targetPaths) {
          expect(await pathExists(path)).to.be.true
        }

        const metadataKey = `test.test.${action.versionString()}`
        const metadataFilename = `.metadata.${metadataKey}.json`
        const metadataPath = join(garden.artifactsPath, metadataFilename)
        expect(await pathExists(metadataPath)).to.be.true

        const metadata = JSON.parse((await readFile(metadataPath)).toString())
        expect(metadata).to.eql({
          key: metadataKey,
          files: targetPaths,
        })
      })
    })

    describe("test.getResult", () => {
      it("should correctly call the corresponding plugin handler", async () => {
        // const test = testFromModule(module, "unit", graph.moduleGraph)
        const testConfig = findByName(module.testConfigs, "unit")!
        const action = await executeTestAction(module, testConfig)
        const result = await actionRouter.test.getResult({
          log,
          action,
          graph,
        })
        expect(result).to.eql({
          moduleName: module.name,
          command: [],
          completedAt: now,
          log: "bla bla",
          outputs: {
            log: "bla bla",
          },
          success: true,
          startedAt: now,
          testName: "unit",
          version: action.versionString(),
        })
      })
    })

    it("should emit a testStatus event", async () => {
      garden.events.eventLog = []
      // const test = testFromModule(module, "unit", graph.moduleGraph)
      const testConfig = findByName(module.testConfigs, "unit")!
      const action = await executeTestAction(module, testConfig)
      await actionRouter.test.getResult({
        log,
        action,
        graph,
      })
      const event = garden.events.eventLog[0]
      expect(event).to.exist
      expect(event.name).to.eql("testStatus")
      expect(event.payload.testName).to.eql("unit")
      expect(event.payload.moduleName).to.eql("module-a")
      expect(event.payload.moduleVersion).to.eql(module.version.versionString)
      expect(event.payload.testVersion).to.eql(action.versionString())
      expect(event.payload.actionUid).to.be.undefined
      expect(event.payload.status.state).to.eql("succeeded")
    })
  })

  describe("deploy actions", () => {
    describe("deploy.getStatus", () => {
      it("should correctly call the corresponding plugin handler", async () => {
        const result = await actionRouter.deploy.getStatus({
          log,
          action: resolvedDeployAction,
          graph,
          devMode: false,

          localMode: false,
        })
        expect(result).to.eql({ forwardablePorts: [], state: "ready", detail: {}, outputs: { base: "ok", foo: "ok" } })
      })

      it("should emit a serviceStatus event", async () => {
        garden.events.eventLog = []
        await actionRouter.deploy.getStatus({
          log,
          action: resolvedDeployAction,
          graph,
          devMode: false,
          localMode: false,
        })
        const event = garden.events.eventLog[0]
        expect(event).to.exist
        expect(event.name).to.eql("serviceStatus")
        expect(event.payload.serviceName).to.eql("service-a")
        expect(event.payload.moduleVersion).to.eql(resolvedDeployAction.versionString())
        expect(event.payload.serviceVersion).to.eql(resolvedDeployAction.versionString())
        expect(event.payload.actionUid).to.be.undefined
        expect(event.payload.status.state).to.eql("ready")
      })

      it("should throw if the outputs don't match the service outputs schema of the plugin", async () => {
        stubRouterAction(actionRouter, "Deploy", "getStatus", async (_params) => {
          return { state: "ready", detail: { state: "ready", detail: {} }, outputs: { base: "ok", foo: 123 } }
        })

        await expectError(
          () =>
            actionRouter.deploy.getStatus({
              log,
              action: resolvedDeployAction,
              graph,
              devMode: false,
              localMode: false,
            }),
          (err) =>
            expect(stripAnsi(err.message)).to.equal(
              "Error validating outputs from service 'service-a': key .foo must be a string"
            )
        )
      })

      it("should throw if the outputs don't match the service outputs schema of a plugin's base", async () => {
        stubRouterAction(actionRouter, "Deploy", "getStatus", async (_params) => {
          return { state: "ready", detail: { state: "ready", detail: {} }, outputs: { base: 123, foo: "ok" } }
        })

        await expectError(
          () =>
            actionRouter.deploy.getStatus({
              log,
              action: resolvedDeployAction,
              graph,
              devMode: false,
              localMode: false,
            }),
          (err) =>
            expect(stripAnsi(err.message)).to.equal(
              "Error validating outputs from service 'service-a': key .base must be a string"
            )
        )
      })
    })

    describe("deploy.deploy", () => {
      it("should correctly call the corresponding plugin handler", async () => {
        const result = await actionRouter.deploy.deploy({
          log,
          action: resolvedDeployAction,
          graph,
          force: true,
          devMode: false,
          localMode: false,
        })
        expect(result).to.eql({ forwardablePorts: [], state: "ready", detail: {}, outputs: { base: "ok", foo: "ok" } })
      })

      it("should emit serviceStatus events", async () => {
        garden.events.eventLog = []
        await actionRouter.deploy.deploy({
          log,
          action: resolvedDeployAction,
          graph,
          force: true,
          devMode: false,
          localMode: false,
        })
        const moduleVersion = resolvedDeployAction.versionString()
        const event1 = garden.events.eventLog[0]
        const event2 = garden.events.eventLog[1]
        expect(event1).to.exist
        expect(event1.name).to.eql("serviceStatus")
        expect(event1.payload.serviceName).to.eql("service-a")
        expect(event1.payload.moduleName).to.eql("module-a")
        expect(event1.payload.moduleVersion).to.eql(moduleVersion)
        expect(event1.payload.serviceVersion).to.eql(resolvedDeployAction.versionString())
        expect(event1.payload.actionUid).to.be.ok
        expect(event1.payload.status.state).to.eql("deploying")
        expect(event2).to.exist
        expect(event2.name).to.eql("serviceStatus")
        expect(event2.payload.serviceName).to.eql("service-a")
        expect(event2.payload.moduleName).to.eql("module-a")
        expect(event2.payload.moduleVersion).to.eql(moduleVersion)
        expect(event2.payload.serviceVersion).to.eql(resolvedDeployAction.versionString())
        expect(event2.payload.actionUid).to.eql(event2.payload.actionUid)
        expect(event2.payload.status.state).to.eql("ready")
      })

      it("should throw if the outputs don't match the service outputs schema of the plugin", async () => {
        stubRouterAction(actionRouter, "Deploy", "deploy", async (_params) => {
          return { state: "ready", detail: { state: "ready", detail: {} }, outputs: { base: "ok", foo: 123 } }
        })

        await expectError(
          () =>
            actionRouter.deploy.deploy({
              log,
              action: resolvedDeployAction,
              graph,
              force: true,
              devMode: false,
              localMode: false,
            }),
          (err) =>
            expect(stripAnsi(err.message)).to.equal(
              "Error validating outputs from service 'service-a': key .foo must be a string"
            )
        )
      })

      it("should throw if the outputs don't match the service outputs schema of a plugin's base", async () => {
        stubRouterAction(actionRouter, "Deploy", "deploy", async (_params) => {
          return { state: "ready", detail: { state: "ready", detail: {} }, outputs: { base: 123, foo: "ok" } }
        })

        await expectError(
          () =>
            actionRouter.deploy.deploy({
              log,
              action: resolvedDeployAction,
              graph,
              force: true,
              devMode: false,
              localMode: false,
            }),
          (err) =>
            expect(stripAnsi(err.message)).to.equal(
              "Error validating outputs from service 'service-a': key .base must be a string"
            )
        )
      })
    })

    describe("deploy.delete", () => {
      it("should correctly call the corresponding plugin handler", async () => {
        const result = await actionRouter.deploy.delete({ log, action: resolvedDeployAction, graph })
        expect(result).to.eql({ forwardablePorts: [], state: "ready", detail: {}, outputs: {} })
      })
    })

    describe("deploy.exec", () => {
      it("should correctly call the corresponding plugin handler", async () => {
        const result = await actionRouter.deploy.exec({
          log,
          action: await garden.executeAction({ action: resolvedDeployAction, log: garden.log, graph }),
          graph,
          command: ["foo"],
          interactive: false,
        })
        expect(result).to.eql({ code: 0, output: "bla bla" })
      })
    })

    describe("deploy.getLogs", () => {
      it("should correctly call the corresponding plugin handler", async () => {
        const stream = new Stream<ServiceLogEntry>()
        const result = await actionRouter.deploy.getLogs({
          log,
          action: resolvedDeployAction,
          graph,
          stream,
          follow: false,
          tail: -1,
        })
        expect(result).to.eql({})
      })
    })

    describe("deploy.run", () => {
      it("should correctly call the corresponding plugin handler", async () => {
        const result = await actionRouter.deploy.run({
          log,
          action: resolvedDeployAction,
          interactive: true,
          graph,
        })
        expect(result).to.eql({
          moduleName: resolvedDeployAction.name,
          command: ["foo"],
          completedAt: now,
          log: "bla bla",
          success: true,
          startedAt: now,
          version: resolvedDeployAction.versionString(),
        })
      })
    })
  })

  describe("task actions", () => {
    let taskResult

    before(() => {
      taskResult = {
        moduleName: resolvedDeployAction.name,
        taskName: resolvedRunAction.name,
        command: ["foo"],
        completedAt: now,
        log: "bla bla",
        outputs: {
          base: "ok",
          foo: "ok",
        },
        success: true,
        startedAt: now,
        version: resolvedRunAction.versionString(),
      }
    })

    describe("run.getResult", () => {
      it("should correctly call the corresponding plugin handler", async () => {
        const result = await actionRouter.run.getResult({
          log,
          action: resolvedRunAction,
          graph,
        })
        expect(result).to.eql(taskResult)
      })

      it("should emit a taskStatus event", async () => {
        garden.events.eventLog = []
        await actionRouter.run.getResult({
          log,
          action: resolvedRunAction,
          graph,
        })
        const event = garden.events.eventLog[0]
        expect(event).to.exist
        expect(event.name).to.eql("taskStatus")
        expect(event.payload.taskName).to.eql("task-a")
        expect(event.payload.moduleName).to.eql("module-a")
        expect(event.payload.moduleVersion).to.eql(resolvedRunAction.versionString())
        expect(event.payload.taskVersion).to.eql(resolvedRunAction.versionString())
        expect(event.payload.actionUid).to.be.undefined
        expect(event.payload.status.state).to.eql("succeeded")
      })

      it("should throw if the outputs don't match the task outputs schema of the plugin", async () => {
        stubRouterAction(actionRouter, "Run", "getResult", async (_params) => {
          return {
            state: "ready",
            detail: { success: true, startedAt: new Date(), completedAt: new Date(), log: "" },
            outputs: { base: "ok", foo: 123 },
          }
        })

        await expectError(
          () => actionRouter.run.getResult({ log, action: resolvedRunAction, graph }),
          (err) =>
            expect(stripAnsi(err.message)).to.equal(
              "Error validating outputs from task 'task-a': key .foo must be a string"
            )
        )
      })

      it("should throw if the outputs don't match the task outputs schema of a plugin's base", async () => {
        stubRouterAction(actionRouter, "Run", "getResult", async (_params) => {
          return {
            state: "ready",
            detail: { success: true, startedAt: new Date(), completedAt: new Date(), log: "" },
            outputs: { base: 123, foo: "ok" },
          }
        })

        await expectError(
          () => actionRouter.run.getResult({ log, action: resolvedRunAction, graph }),
          (err) =>
            expect(stripAnsi(err.message)).to.equal(
              "Error validating outputs from task 'task-a': key .base must be a string"
            )
        )
      })
    })

    describe("run.run", () => {
      it("should correctly call the corresponding plugin handler", async () => {
        const result = await actionRouter.run.run({
          log,
          action: resolvedRunAction,
          interactive: true,
          graph,
        })
        expect(result).to.eql(taskResult)
      })

      it("should emit taskStatus events", async () => {
        garden.events.eventLog = []
        await actionRouter.run.run({
          log,
          action: resolvedRunAction,
          interactive: true,
          graph,
        })
        const moduleVersion = resolvedRunAction.versionString()
        const event1 = garden.events.eventLog[0]
        const event2 = garden.events.eventLog[1]
        expect(event1).to.exist
        expect(event1.name).to.eql("taskStatus")
        expect(event1.payload.taskName).to.eql("task-a")
        expect(event1.payload.moduleName).to.eql("module-a")
        expect(event1.payload.moduleVersion).to.eql(moduleVersion)
        expect(event1.payload.taskVersion).to.eql(resolvedRunAction.versionString())
        expect(event1.payload.actionUid).to.be.ok
        expect(event1.payload.status.state).to.eql("running")
        expect(event2).to.exist
        expect(event2.name).to.eql("taskStatus")
        expect(event2.payload.taskName).to.eql("task-a")
        expect(event2.payload.moduleName).to.eql("module-a")
        expect(event2.payload.moduleVersion).to.eql(moduleVersion)
        expect(event2.payload.taskVersion).to.eql(resolvedRunAction.versionString())
        expect(event2.payload.actionUid).to.eql(event1.payload.actionUid)
        expect(event2.payload.status.state).to.eql("succeeded")
      })

      it("should throw if the outputs don't match the task outputs schema of the plugin", async () => {
        stubRouterAction(actionRouter, "Run", "run", async (_params) => {
          return {
            state: "ready",
            detail: { success: true, startedAt: new Date(), completedAt: new Date(), log: "" },
            outputs: { base: "ok", foo: 123 },
          }
        })

        await expectError(
          () =>
            actionRouter.run.run({
              log,
              action: resolvedRunAction,
              interactive: true,
              graph,
            }),
          (err) =>
            expect(stripAnsi(err.message)).to.equal(
              "Error validating outputs from task 'task-a': key .foo must be a string"
            )
        )
      })

      it("should throw if the outputs don't match the task outputs schema of a plugin's base", async () => {
        stubRouterAction(actionRouter, "Run", "run", async (_params) => {
          return {
            state: "ready",
            detail: { success: true, startedAt: new Date(), completedAt: new Date(), log: "" },
            outputs: { base: 123, foo: "ok" },
          }
        })

        await expectError(
          () =>
            actionRouter.run.run({
              log,
              action: resolvedRunAction,
              interactive: true,
              graph,
            }),
          (err) =>
            expect(stripAnsi(err.message)).to.equal(
              "Error validating outputs from task 'task-a': key .base must be a string"
            )
        )
      })

      it("should copy artifacts exported by the handler to the artifacts directory", async () => {
        await emptyDir(garden.artifactsPath)

        graph = await garden.getConfigGraph({ log: garden.log, emit: false })
        const runActionTaskA = graph.getRun("task-a")

        runActionTaskA.getConfig().spec.artifacts = [
          {
            source: "some-file.txt",
          },
          {
            source: "some-dir/some-file.txt",
            target: "some-dir/some-file.txt",
          },
        ]

        await actionRouter.run.run({
          log,
          action: await garden.resolveAction({
            action: runActionTaskA,
            log: garden.log,
            graph: await garden.getConfigGraph({ log: garden.log, emit: false }),
          }),
          interactive: true,
          graph,
        })

        const targetPaths = runActionTaskA
          .getConfig()
          .spec.artifacts.map((spec) => join(garden.artifactsPath, spec.source))
          .sort()

        for (const path of targetPaths) {
          expect(await pathExists(path)).to.be.true
        }

        const metadataKey = `run.task-a.${runActionTaskA.versionString()}`
        const metadataFilename = `.metadata.${metadataKey}.json`
        const metadataPath = join(garden.artifactsPath, metadataFilename)
        expect(await pathExists(metadataPath)).to.be.true

        const metadata = JSON.parse((await readFile(metadataPath)).toString())
        expect(metadata).to.eql({
          key: metadataKey,
          files: targetPaths,
        })
      })
    })
  })

  describe("getActionHandlers", () => {
    it("should return all handlers for a type", async () => {
      const handlers = await actionRouter["getActionHandlers"]("prepareEnvironment")

      expect(Object.keys(handlers)).to.eql(["exec", "test-plugin", "test-plugin-b"])
    })
  })

  describe("getModuleActionHandlers", () => {
    it("should return all handlers for a type", async () => {
      const handlers = await actionRouter["getModuleActionHandlers"]({ handlerType: "build", moduleType: "exec" })

      expect(Object.keys(handlers)).to.eql(["exec"])
    })
  })

  describe("getActionHandler", () => {
    it("should return the configured handler for specified action type and plugin name", async () => {
      const gardenA = await makeTestGardenA()
      const actionsA = await gardenA.getActionRouter()
      const pluginName = "test-plugin-b"
      const handler = await actionsA.provider["getPluginHandler"]({ handlerType: "prepareEnvironment", pluginName })

      expect(handler!.handlerType).to.equal("prepareEnvironment")
      expect(handler!.pluginName).to.equal(pluginName)
    })

    it("should throw if no handler is available", async () => {
      const gardenA = await makeTestGardenA()
      const actionsA = await gardenA.getActionRouter()
      const pluginName = "test-plugin-b"
      await expectError(
        () =>
          actionsA.provider["getPluginHandler"]({
            handlerType: "cleanupEnvironment",
            pluginName,
          }),
        "plugin"
      )
    })
  })

  describe("getModuleActionHandler", () => {
    const path = projectRootA

    it("should return default handler, if specified and no handler is available", async () => {
      const gardenA = await makeTestGardenA()
      const actionsA = await gardenA.getActionRouter()
      const defaultHandler = async () => {
        return { code: 0, output: "" }
      }
      const handler = await actionsA["getModuleHandler"]({
        handlerType: "execInService",
        moduleType: "container",
        defaultHandler,
      })
      expect(handler.handlerType).to.equal("execInService")
      expect(handler.moduleType).to.equal("container")
      expect(handler.pluginName).to.equal(defaultProvider.name)
    })

    it("should throw if no handler is available", async () => {
      const gardenA = await makeTestGardenA()
      const actionsA = await gardenA.getActionRouter()
      await expectError(
        () => actionsA["getModuleHandler"]({ handlerType: "execInService", moduleType: "container" }),
        "parameter"
      )
    })

    context("when no providers extend the module type with requested handler", () => {
      it("should return the handler from the provider that created it", async () => {
        const foo = createGardenPlugin({
          name: "foo",
          createModuleTypes: [
            {
              name: "bar",
              docs: "bar",
              schema: joi.object(),
              needsBuild: true,
              handlers: {
                // build: async () => ({}),
              },
            },
          ],
        })

        const _garden = await makeTestGarden(path, {
          plugins: [foo],
          config: {
            apiVersion: DEFAULT_API_VERSION,
            kind: "Project",
            name: "test",
            path,
            defaultEnvironment: "default",
            dotIgnoreFile: defaultDotIgnoreFile,
            environments: [{ name: "default", defaultNamespace, variables: {} }],
            providers: [{ name: "foo" }],
            variables: {},
          },
        })

        const _actions = await _garden.getActionRouter()

        const handler = await _actions["getModuleHandler"]({ handlerType: "build", moduleType: "bar" })

        expect(handler.handlerType).to.equal("build")
        expect(handler.moduleType).to.equal("bar")
        expect(handler.pluginName).to.equal("foo")
      })
    })

    context("when one provider overrides the requested handler on the module type", () => {
      it("should return the handler from the extending provider", async () => {
        const base = createGardenPlugin({
          name: "base",
          createModuleTypes: [
            {
              name: "bar",
              docs: "bar",
              schema: joi.object(),
              needsBuild: true,
              handlers: {
                // build: async () => ({}),
              },
            },
          ],
        })
        const foo = createGardenPlugin({
          name: "foo",
          dependencies: [{ name: "base" }],
          extendModuleTypes: [
            {
              name: "bar",
              needsBuild: true,
              handlers: {
                // build: async () => ({}),
              },
            },
          ],
        })

        const _garden = await makeTestGarden(path, {
          plugins: [base, foo],
          config: {
            apiVersion: DEFAULT_API_VERSION,
            kind: "Project",
            name: "test",
            path,
            defaultEnvironment: "default",
            dotIgnoreFile: defaultDotIgnoreFile,
            environments: [{ name: "default", defaultNamespace, variables: {} }],
            providers: [{ name: "base" }, { name: "foo" }],
            variables: {},
          },
        })

        const _actions = await _garden.getActionRouter()

        const handler = await _actions["getModuleHandler"]({ handlerType: "build", moduleType: "bar" })

        expect(handler.handlerType).to.equal("build")
        expect(handler.moduleType).to.equal("bar")
        expect(handler.pluginName).to.equal("foo")
      })
    })

    context("when multiple providers extend the module type with requested handler", () => {
      it("should return the handler that is not being overridden by another handler", async () => {
        const base = createGardenPlugin({
          name: "base",
          createModuleTypes: [
            {
              name: "bar",
              docs: "bar",
              schema: joi.object(),
              needsBuild: true,
              handlers: {
                // build: async () => ({}),
              },
            },
          ],
        })
        const foo = createGardenPlugin({
          name: "foo",
          dependencies: [{ name: "base" }],
          extendModuleTypes: [
            {
              name: "bar",
              needsBuild: true,
              handlers: {
                // build: async () => ({}),
              },
            },
          ],
        })
        const too = createGardenPlugin({
          name: "too",
          dependencies: [{ name: "base" }, { name: "foo" }],
          extendModuleTypes: [
            {
              name: "bar",
              needsBuild: true,
              handlers: {
                // build: async () => ({}),
              },
            },
          ],
        })

        const _garden = await makeTestGarden(path, {
          plugins: [base, too, foo],
          config: {
            apiVersion: DEFAULT_API_VERSION,
            kind: "Project",
            name: "test",
            path,
            defaultEnvironment: "default",
            dotIgnoreFile: defaultDotIgnoreFile,
            environments: [{ name: "default", defaultNamespace, variables: {} }],
            providers: [
              { name: "base" },
              // The order here matters, to verify that the dependency ordering works
              { name: "too" },
              { name: "foo" },
            ],
            variables: {},
          },
        })

        const _actions = await _garden.getActionRouter()

        const handler = await _actions["getModuleHandler"]({ handlerType: "build", moduleType: "bar" })

        expect(handler.handlerType).to.equal("build")
        expect(handler.moduleType).to.equal("bar")
        expect(handler.pluginName).to.equal("too")
      })

      context("when multiple providers are side by side in the dependency graph", () => {
        it("should return the last configured handler for the specified module action type", async () => {
          const base = createGardenPlugin({
            name: "base",
            createModuleTypes: [
              {
                name: "bar",
                docs: "bar",
                schema: joi.object(),
                needsBuild: true,
                handlers: {
                  // build: async () => ({}),
                },
              },
            ],
          })
          const foo = createGardenPlugin({
            name: "foo",
            dependencies: [{ name: "base" }],
            extendModuleTypes: [
              {
                name: "bar",
                needsBuild: true,
                handlers: {
                  // build: async () => ({}),
                },
              },
            ],
          })
          const too = createGardenPlugin({
            name: "too",
            dependencies: [{ name: "base" }],
            extendModuleTypes: [
              {
                name: "bar",
                needsBuild: true,
                handlers: {
                  // build: async () => ({}),
                },
              },
            ],
          })

          const _garden = await makeTestGarden(path, {
            plugins: [base, too, foo],
            config: {
              apiVersion: DEFAULT_API_VERSION,
              kind: "Project",
              name: "test",
              path,
              defaultEnvironment: "default",
              dotIgnoreFile: defaultDotIgnoreFile,
              environments: [{ name: "default", defaultNamespace, variables: {} }],
              providers: [
                { name: "base" },
                // The order here matters, since we use that as a "tie-breaker"
                { name: "foo" },
                { name: "too" },
              ],
              variables: {},
            },
          })

          const _actions = await _garden.getActionRouter()

          const handler = await _actions["getModuleHandler"]({ handlerType: "build", moduleType: "bar" })

          expect(handler.handlerType).to.equal("build")
          expect(handler.moduleType).to.equal("bar")
          expect(handler.pluginName).to.equal("too")
        })
      })
    })

    context("when the handler was added by a provider and not specified in the creating provider", () => {
      it("should return the added handler", async () => {
        const base = createGardenPlugin({
          name: "base",
          createModuleTypes: [
            {
              name: "bar",
              docs: "bar",
              schema: joi.object(),
              needsBuild: true,
              handlers: {},
            },
          ],
        })
        const foo = createGardenPlugin({
          name: "foo",
          dependencies: [{ name: "base" }],
          extendModuleTypes: [
            {
              name: "bar",
              needsBuild: true,
              handlers: {
                // build: async () => ({}),
              },
            },
          ],
        })

        const _garden = await makeTestGarden(path, {
          plugins: [base, foo],
          config: {
            apiVersion: DEFAULT_API_VERSION,
            kind: "Project",
            name: "test",
            path,
            defaultEnvironment: "default",
            dotIgnoreFile: defaultDotIgnoreFile,
            environments: [{ name: "default", defaultNamespace, variables: {} }],
            providers: [{ name: "base" }, { name: "foo" }],
            variables: {},
          },
        })

        const _actions = await _garden.getActionRouter()

        const handler = await _actions["getModuleHandler"]({ handlerType: "build", moduleType: "bar" })

        expect(handler.handlerType).to.equal("build")
        expect(handler.moduleType).to.equal("bar")
        expect(handler.pluginName).to.equal("foo")
      })
    })

    context("when the module type has a base", () => {
      const projectConfigWithBase: ProjectConfig = {
        apiVersion: DEFAULT_API_VERSION,
        kind: "Project",
        name: "test",
        path,
        defaultEnvironment: "default",
        dotIgnoreFile: defaultDotIgnoreFile,
        environments: [{ name: "default", defaultNamespace, variables: {} }],
        providers: [{ name: "base" }, { name: "foo" }],
        variables: {},
      }

      it("should return the handler for the specific module type, if available", async () => {
        const base = createGardenPlugin({
          name: "base",
          createModuleTypes: [
            {
              name: "bar",
              docs: "bar",
              schema: joi.object(),
              needsBuild: true,
              handlers: {
                // build: async () => ({}),
              },
            },
          ],
        })
        const foo = createGardenPlugin({
          name: "foo",
          dependencies: [{ name: "base" }],
          createModuleTypes: [
            {
              name: "moo",
              base: "bar",
              docs: "moo",
              schema: joi.object(),
              needsBuild: true,
              handlers: {
                // build: async () => ({}),
              },
            },
          ],
        })

        const _garden = await makeTestGarden(path, {
          plugins: [base, foo],
          config: projectConfigWithBase,
        })

        const _actions = await _garden.getActionRouter()

        const handler = await _actions["getModuleHandler"]({ handlerType: "build", moduleType: "moo" })

        expect(handler.handlerType).to.equal("build")
        expect(handler.moduleType).to.equal("moo")
        expect(handler.pluginName).to.equal("foo")
      })

      it("should fall back on the base if no specific handler is available", async () => {
        const base = createGardenPlugin({
          name: "base",
          createModuleTypes: [
            {
              name: "bar",
              docs: "bar",
              schema: joi.object(),
              needsBuild: true,
              handlers: {
                // build: async () => ({ buildLog: "base" }),
              },
            },
          ],
        })
        const foo = createGardenPlugin({
          name: "foo",
          dependencies: [{ name: "base" }],
          createModuleTypes: [
            {
              name: "moo",
              base: "bar",
              docs: "moo",
              schema: joi.object(),
              needsBuild: true,
              handlers: {},
            },
          ],
        })

        const _garden = await makeTestGarden(path, {
          plugins: [base, foo],
          config: projectConfigWithBase,
        })

        const _actions = await _garden.getActionRouter()

        const handler = await _actions["getModuleHandler"]({ handlerType: "build", moduleType: "moo" })

        expect(handler.handlerType).to.equal("build")
        expect(handler.moduleType).to.equal("bar")
        expect(handler.pluginName).to.equal("base")
        expect(await handler(<any>{})).to.eql({ buildLog: "base" })
      })

      it("should recursively fall back on the base's bases if needed", async () => {
        const baseA = createGardenPlugin({
          name: "base-a",
          createModuleTypes: [
            {
              name: "base-a",
              docs: "base A",
              schema: joi.object(),
              needsBuild: true,
              handlers: {
                // build: async () => ({ buildLog: "base" }),
              },
            },
          ],
        })
        const baseB = createGardenPlugin({
          name: "base-b",
          dependencies: [{ name: "base-a" }],
          createModuleTypes: [
            {
              name: "base-b",
              base: "base-a",
              docs: "base B",
              schema: joi.object(),
              needsBuild: true,
              handlers: {},
            },
          ],
        })
        const foo = createGardenPlugin({
          name: "foo",
          dependencies: [{ name: "base-b" }],
          createModuleTypes: [
            {
              name: "moo",
              base: "base-b",
              docs: "moo",
              schema: joi.object(),
              needsBuild: true,
              handlers: {},
            },
          ],
        })

        const _garden = await makeTestGarden(path, {
          plugins: [baseA, baseB, foo],
          config: {
            apiVersion: DEFAULT_API_VERSION,
            kind: "Project",
            name: "test",
            path,
            defaultEnvironment: "default",
            dotIgnoreFile: defaultDotIgnoreFile,
            environments: [{ name: "default", defaultNamespace, variables: {} }],
            providers: [{ name: "base-a" }, { name: "base-b" }, { name: "foo" }],
            variables: {},
          },
        })

        const _actions = await _garden.getActionRouter()

        const handler = await _actions["getModuleHandler"]({ handlerType: "build", moduleType: "moo" })

        expect(handler.handlerType).to.equal("build")
        expect(handler.moduleType).to.equal("base-a")
        expect(handler.pluginName).to.equal("base-a")
        expect(await handler(<any>{})).to.eql({ buildLog: "base" })
      })
    })
  })

  describe("callActionHandler", () => {
    it("should call the handler with a base argument if the handler is overriding another", async () => {
      const emptyActions = new ActionRouter(garden, [], [], {})

      const base = Object.assign(
        async () => ({
          ready: true,
          outputs: {},
        }),
        { handlerType: "getEnvironmentStatus", pluginName: "base" }
      )

      const handler: ActionHandler<any, any> = async (params) => {
        expect(params.base).to.equal(base)

        return { ready: true, outputs: {} }
      }

      handler.base = base

      await emptyActions["callActionHandler"]({
        handlerType: "getEnvironmentStatus", // Doesn't matter which one it is
        pluginName: "test-plugin",
        params: {
          log,
        },
        defaultHandler: handler,
      })
    })

    it("should recursively override the base parameter when calling a base handler", async () => {
      const baseA = createGardenPlugin({
        name: "base-a",
        handlers: {
          getSecret: async (params) => {
            expect(params.base).to.not.exist
            return { value: params.key }
          },
        },
      })
      const baseB = createGardenPlugin({
        name: "base-b",
        base: "base-a",
        handlers: {
          getSecret: async (params) => {
            expect(params.base).to.exist
            expect(params.base!.base).to.not.exist
            return params.base!(params)
          },
        },
      })
      const foo = createGardenPlugin({
        name: "foo",
        base: "base-b",
        handlers: {
          getSecret: async (params) => {
            expect(params.base).to.exist
            expect(params.base!.base).to.exist
            return params.base!(params)
          },
        },
      })

      const path = projectRootA

      const _garden = await makeTestGarden(path, {
        plugins: [baseA, baseB, foo],
        config: {
          apiVersion: DEFAULT_API_VERSION,
          kind: "Project",
          name: "test",
          path,
          defaultEnvironment: "default",
          dotIgnoreFile: defaultDotIgnoreFile,
          environments: [{ name: "default", defaultNamespace, variables: {} }],
          providers: [{ name: "foo" }],
          variables: {},
        },
      })

      const _actions = await _garden.getActionRouter()

      const result = await _actions["callActionHandler"]({
        handlerType: "getSecret", // Doesn't matter which one it is
        pluginName: "foo",
        params: {
          key: "foo",
          log,
        },
      })

      expect(result).to.eql({ value: "foo" })
    })

    it("should call the handler with the template context for the provider", async () => {
      const emptyActions = new ActionRouter(garden, [], [], {})

      const handler: ActionHandler<any, any> = async ({ ctx }) => {
        const resolved = ctx.resolveTemplateStrings("${environment.name}")
        return { ready: true, outputs: { resolved } }
      }

      const result = await emptyActions["callActionHandler"]({
        handlerType: "getEnvironmentStatus", // Doesn't matter which one it is
        pluginName: "test-plugin",
        params: {
          log,
        },
        defaultHandler: handler,
      })

      expect(result.outputs?.resolved).to.equal("default")
    })
  })

  describe("callModuleHandler", () => {
    it("should call the handler with a base argument if the handler is overriding another", async () => {
      const emptyActions = new ActionRouter(garden, [], [], {
        test: {
          name: "test",
          docs: "test",
          needsBuild: true,
          handlers: {},
        },
      })

      graph = await garden.getConfigGraph({ log: garden.log, emit: false })
      const moduleA = graph.getModule("module-a")

      const base = Object.assign(
        async () => ({
          ready: true,
          outputs: {},
        }),
        { handlerType: "getBuildStatus", pluginName: "base", moduleType: "test" }
      )

      const handler: ModuleActionHandler<any, any> = async (params) => {
        expect(params.base).to.equal(base)
        return { ready: true, outputs: {} }
      }

      handler.base = base

      await emptyActions["callModuleHandler"]({
        handlerType: "getBuildStatus", // Doesn't matter which one it is
        params: {
          module: moduleA,
          log,
          graph,
        },
        defaultHandler: handler,
      })
    })

    it("should call the handler with the template context for the module", async () => {
      const emptyActions = new ActionRouter(garden, [], [], {
        test: {
          name: "test",
          docs: "test",
          needsBuild: true,
          handlers: {},
        },
      })

      graph = await garden.getConfigGraph({ log: garden.log, emit: false })
      const moduleA = graph.getModule("module-a")
      const moduleB = graph.getModule("module-b")

      const handler: ModuleActionHandler<any, any> = async ({ ctx }) => {
        const resolved = ctx.resolveTemplateStrings("${modules.module-a.version}")
        return { ready: true, detail: { resolved } }
      }

      const result = await emptyActions["callModuleHandler"]({
        handlerType: "getBuildStatus", // Doesn't matter which one it is
        params: {
          module: moduleB,
          log,
          graph,
        },
        defaultHandler: handler,
      })

      expect(result.detail?.resolved).to.equal(moduleA.version.versionString)
    })
  })

  describe("callServiceHandler", () => {
    it("should call the handler with a base argument if the handler is overriding another", async () => {
      const emptyActions = new ActionRouter(garden, [], [], {
        test: {
          name: "test",
          docs: "test",
          needsBuild: true,
          handlers: {},
        },
      })

      graph = await garden.getConfigGraph({ log: garden.log, emit: false })
      const deployServiceA = graph.getDeploy("service-a")

      const base = Object.assign(
        async () => ({
          forwardablePorts: [],
          state: <ServiceState>"ready",
          detail: {},
        }),
        { handlerType: "deployService", pluginName: "base", moduleType: "test" }
      )

      const handler: ModuleActionHandler<any, any> = async (params) => {
        expect(params.base).to.equal(base)
        return { forwardablePorts: [], state: <ServiceState>"ready", detail: {} }
      }

      handler.base = base

      await emptyActions["callServiceHandler"]({
        handlerType: "deployService", // Doesn't matter which one it is
        params: {
          service: deployServiceA,
          graph,
          log,
          devMode: false,
          localMode: false,
          force: false,
        },
        defaultHandler: handler,
      })
    })

    it("should call the handler with the template context for the service", async () => {
      const emptyActions = new ActionRouter(garden, [], [], {
        test: {
          name: "test",
          docs: "test",
          needsBuild: true,
          handlers: {},
        },
      })

      graph = await garden.getConfigGraph({ log: garden.log, emit: false })
      const deployServiceA = graph.getDeploy("service-a")
      const deployServiceB = graph.getDeploy("service-b")

      const handler: ModuleActionHandler<any, any> = async ({ ctx }) => {
        const resolved = ctx.resolveTemplateStrings("${runtime.services.service-a.version}")
        return { forwardablePorts: [], state: <ServiceState>"ready", detail: { resolved } }
      }

      const { result } = await emptyActions["callServiceHandler"]({
        handlerType: "deployService", // Doesn't matter which one it is
        params: {
          service: deployServiceB,
          graph,
          log,
          devMode: false,

          localMode: false,
          force: false,
        },
        defaultHandler: handler,
      })

      expect(result.detail?.resolved).to.equal(deployServiceA.versionString())
    })
  })

  describe("callTaskHandler", () => {
    it("should call the handler with a base argument if the handler is overriding another", async () => {
      const emptyActions = new ActionRouter(garden, [], [], {
        test: {
          name: "test",
          docs: "test",
          needsBuild: true,
          handlers: {},
        },
      })

      graph = await garden.getConfigGraph({ log: garden.log, emit: false })
      const runTaskA = graph.getRun("task-a")

      const base = Object.assign(
        async () => ({
          moduleName: "module-a",
          taskName: "task-a",
          command: [],
          outputs: { moo: "boo" },
          success: true,
          version: resolvedRunAction.versionString(),
          startedAt: new Date(),
          completedAt: new Date(),
          log: "boo",
        }),
        { handlerType: "runTask", pluginName: "base", moduleType: "test" }
      )

      const handler: ModuleActionHandler<any, any> = async (params) => {
        expect(params.base).to.equal(base)
        return {
          moduleName: "module-a",
          taskName: "task-a",
          command: [],
          outputs: { moo: "boo" },
          success: true,
          version: resolvedRunAction.versionString(),
          startedAt: new Date(),
          completedAt: new Date(),
          log: "boo",
        }
      }

      handler.base = base

      await emptyActions["callTaskHandler"]({
        handlerType: "runTask",
        params: {
          artifactsPath: "/tmp",
          task: runTaskA,
          graph,
          log,
          interactive: false,
        },
        defaultHandler: handler,
      })
    })

    it("should call the handler with the template context for the task", async () => {
      const emptyActions = new ActionRouter(garden, [], [], {
        test: {
          name: "test",
          docs: "test",
          needsBuild: true,
          handlers: {},
        },
      })

      graph = await garden.getConfigGraph({ log: garden.log, emit: false })
      const runTaskA = graph.getRun("task-a")
      const deployServiceB = graph.getDeploy("service-b")

      const { result } = await emptyActions["callTaskHandler"]({
        handlerType: "runTask",
        params: {
          artifactsPath: "/tmp", // Not used in this test
          task: runTaskA,
          graph,
          log,
          interactive: false,
        },
        defaultHandler: async ({ ctx }) => {
          const resolved = ctx.resolveTemplateStrings("${runtime.services.service-b.version}")

          return {
            moduleName: "module-a",
            taskName: "task-a",
            command: [],
            outputs: { resolved },
            success: true,
            version: resolvedRunAction.versionString(),
            moduleVersion: resolvedRunAction.versionString(),
            startedAt: new Date(),
            completedAt: new Date(),
            log: "boo",
          }
        },
      })

      expect(result.outputs?.resolved).to.equal(deployServiceB.versionString())
    })
  })
})

const baseOutputsSchema = () => joi.object().keys({ base: joi.string() })
const testOutputSchema = () => baseOutputsSchema().keys({ foo: joi.string() })

const basePlugin = createGardenPlugin({
  name: "base",
  createModuleTypes: [
    {
      name: "base",
      docs: "bla bla bla",
      moduleOutputsSchema: baseOutputsSchema(),
      needsBuild: true,
      handlers: {},
    },
  ],
})

const pluginActionDescriptions = getProviderActionDescriptions()
const moduleActionDescriptions = getModuleHandlerDescriptions()

const testPlugin = createGardenPlugin({
  name: "test-plugin",
  dependencies: [{ name: "base" }],

  handlers: <ProviderHandlers>{
    configureProvider: async (params) => {
      validateParams(params, pluginActionDescriptions.configureProvider.paramsSchema)
      return { config: params.config }
    },

    getEnvironmentStatus: async (params) => {
      validateParams(params, pluginActionDescriptions.getEnvironmentStatus.paramsSchema)
      return {
        ready: false,
        outputs: {},
      }
    },

    augmentGraph: async (params) => {
      validateParams(params, pluginActionDescriptions.augmentGraph.paramsSchema)

      const actionName = "added-by-" + params.ctx.provider.name

      return {
        addDependencies: [
          {
            by: {
              kind: "Deploy",
              name: actionName,
            },
            on: {
              kind: "Build",
              name: actionName,
            },
          },
        ],
        addActions: [
          {
            kind: "Build",
            name: actionName,
            type: "container",
            internal: {
              basePath: ".",
            },
            spec: {},
          },
          {
            kind: "Deploy",
            name: actionName,
            type: "container",
            internal: {
              basePath: ".",
            },
            spec: {},
          },
        ],
      }
    },

    getDashboardPage: async (params) => {
      validateParams(params, pluginActionDescriptions.getDashboardPage.paramsSchema)
      return { url: "http://" + params.page.name }
    },

    getDebugInfo: async (params) => {
      validateParams(params, pluginActionDescriptions.getDebugInfo.paramsSchema)
      return { info: {} }
    },

    prepareEnvironment: async (params) => {
      validateParams(params, pluginActionDescriptions.prepareEnvironment.paramsSchema)
      return { status: { ready: true, outputs: {} } }
    },

    cleanupEnvironment: async (params) => {
      validateParams(params, pluginActionDescriptions.cleanupEnvironment.paramsSchema)
      return {}
    },

    getSecret: async (params) => {
      validateParams(params, pluginActionDescriptions.getSecret.paramsSchema)
      return { value: params.key }
    },

    setSecret: async (params) => {
      validateParams(params, pluginActionDescriptions.setSecret.paramsSchema)
      return {}
    },

    deleteSecret: async (params) => {
      validateParams(params, pluginActionDescriptions.deleteSecret.paramsSchema)
      return { found: true }
    },
  },

  createModuleTypes: [
    {
      name: "test",
      base: "base",
      docs: "bla bla bla",
      moduleOutputsSchema: testOutputSchema(),
      schema: joi.object(),
      needsBuild: true,
      title: "Bla",

      handlers: {
        configure: async (params) => {
          validateParams(params, moduleActionDescriptions.configure.paramsSchema)

          const serviceConfigs = params.moduleConfig.spec.services.map((spec) => ({
            name: spec.name,
            dependencies: spec.dependencies || [],
            disabled: false,

            spec,
          }))

          const taskConfigs = (params.moduleConfig.spec.tasks || []).map((spec) => ({
            name: spec.name,
            dependencies: spec.dependencies || [],
            disabled: false,
            spec,
          }))

          const testConfigs = (params.moduleConfig.spec.tests || []).map((spec) => ({
            name: spec.name,
            dependencies: spec.dependencies || [],
            disabled: false,
            spec,
          }))

          return {
            moduleConfig: {
              ...params.moduleConfig,
              serviceConfigs,
              taskConfigs,
              testConfigs,
            },
          }
        },

        convert: async (params) => {
          validateParams(params, moduleActionDescriptions.convert.paramsSchema)
          const { module, convertBuildDependency } = params
          type TestPluginActionConfig =
            | BuildActionConfig<"test", BaseBuildSpec>
            | DeployActionConfig
            | TestActionConfig
            | RunActionConfig
          const actions: TestPluginActionConfig[] = []

          function prepareEnv(env: StringMap) {
            return { ...module.spec.env, ...env }
          }

          const type = "test"
          actions.push({
            kind: "Build",
            name: module.name,
            type,
            internal: {
              basePath: "test",
            },
            spec: { ...module.spec },
            dependencies: module.build.dependencies.map(convertBuildDependency),
          })

          module.serviceConfigs.forEach((sc) => {
            actions.push({
              kind: "Deploy",
              type,
              name: sc.name,
              internal: {
                basePath: "test",
              },
              spec: {
                ...sc.spec,
                env: prepareEnv(sc.spec.env),
              },
            })
          })

          module.testConfigs.forEach((tc) => {
            actions.push({
              kind: "Test",
              type,
              name: module.name + "-" + tc.name,
              internal: {
                basePath: "test",
              },
              spec: {
                ...tc.spec,
                env: prepareEnv(tc.spec.env),
              },
            })
          })

          module.taskConfigs.forEach((tc) => {
            actions.push({
              kind: "Run",
              type,
              name: module.name + "-" + tc.name,
              internal: {
                basePath: "test",
              },
              spec: {
                ...tc.spec,
                env: prepareEnv(tc.spec.env),
              },
            })
          })

          return {
            group: {
              // This is an annoying TypeScript limitation :P
              kind: <"Group">"Group",
              name: module.name,
              path: module.path,
              actions,
              variables: module.variables,
              varfiles: module.varfile ? [module.varfile] : undefined,
            },
          }
        },

        getModuleOutputs: async (params) => {
          validateParams(params, moduleActionDescriptions.getModuleOutputs.paramsSchema)
          return { outputs: { foo: "bar" } }
        },

        suggestModules: async () => {
          return { suggestions: [] }
        },
      },
    },
  ],
  createActionTypes: {
    Build: [
      {
        name: "test-plugin",
        docs: "Test Build action",
        schema: execBuildActionSchema(),
        handlers: {
          getStatus: async (_params) => {
            return { state: "ready", detail: {}, outputs: { foo: "bar" } }
          },

          build: async (_params) => {
            return { state: "ready", detail: {}, outputs: { foo: "bar" } }
          },

          publish: async (_params) => {
            return { state: "ready", detail: null, outputs: {} }
          },

          run: async (params) => {
            return {
              moduleName: params.action.name,
              command: params.args,
              completedAt: now,
              log: "bla bla",
              success: true,
              startedAt: now,
              version: params.action.versionString(),
            }
          },
        },
      },
    ],
    Deploy: [
      {
        name: "test-plugin",
        docs: "Test Deploy action",
        schema: execDeployActionSchema(),
        handlers: {
          getStatus: async (_params) => {
            return { state: "ready", detail: { state: "ready", detail: {} }, outputs: { base: "ok", foo: "ok" } }
          },

          deploy: async (params) => {
            validateParams(params, moduleActionDescriptions.deployService.paramsSchema)
            return { state: "ready", detail: { state: "ready", detail: {} }, outputs: { base: "ok", foo: "ok" } }
          },

          delete: async (_params) => {
            return { state: "ready", detail: { state: "ready", detail: {} }, outputs: {} }
          },

          exec: async (_params) => {
            return {
              code: 0,
              output: "bla bla",
            }
          },

          getLogs: async (_params) => {
            return {}
          },

          run: async (params) => {
            return {
              moduleName: params.action.name,
              command: ["foo"],
              completedAt: now,
              log: "bla bla",
              success: true,
              startedAt: now,
              version: params.action.versionString(),
            }
          },

          getPortForward: async (params) => {
            validateParams(params, moduleActionDescriptions.getPortForward.paramsSchema)
            return {
              hostname: "bla",
              port: 123,
            }
          },

          stopPortForward: async (params) => {
            validateParams(params, moduleActionDescriptions.stopPortForward.paramsSchema)
            return {}
          },
        },
      },
    ],
    Run: [
      {
        name: "test-plugin",
        docs: "Test Run action",
        schema: execRunActionSchema(),
        handlers: {
          getResult: async (params) => {
            return {
              state: "ready",
              detail: {
                moduleName: params.action.name,
                taskName: params.action.name,
                command: ["foo"],
                completedAt: now,
                log: "bla bla",
                outputs: { base: "ok", foo: "ok" },
                success: true,
                startedAt: now,
                version: params.action.versionString(),
              },
              outputs: {},
            }
          },

          run: async (params) => {
            // Create artifacts, to test artifact copying
            for (const artifact of params.action.getSpec().artifacts || []) {
              await ensureFile(join(params.artifactsPath, artifact.source))
            }

            return {
              state: "ready",
              detail: {
                moduleName: params.action.name,
                taskName: params.action.name,
                command: ["foo"],
                completedAt: now,
                log: "bla bla",
                outputs: { base: "ok", foo: "ok" },
                success: true,
                startedAt: now,
                version: params.action.versionString(),
              },
              outputs: {},
            }
          },
        },
      },
    ],
    Test: [
      {
        name: "test-plugin",
        docs: "Test Test action",
        schema: execTestActionSchema(),
        handlers: {
          run: async (params) => {
            // Create artifacts, to test artifact copying
            for (const artifact of params.action.getSpec().artifacts || []) {
              await ensureFile(join(params.artifactsPath, artifact.source))
            }

            return {
              state: "ready",
              detail: {
                moduleName: params.action.name,
                command: [],
                completedAt: now,
                log: "bla bla",
                outputs: {
                  log: "bla bla",
                },
                success: true,
                startedAt: now,
                testName: params.action.name,
                version: params.action.versionString(),
              },
              outputs: [],
            }
          },

          getResult: async (params) => {
            return {
              state: "ready",
              detail: {
                moduleName: params.action.name,
                command: [],
                completedAt: now,
                log: "bla bla",
                outputs: {
                  log: "bla bla",
                },
                success: true,
                startedAt: now,
                testName: params.action.name,
                version: params.action.versionString(),
              },
              outputs: {},
            }
          },
        },
      },
    ],
  },
})

const testPluginB = createGardenPlugin({
  ...omit(testPlugin, ["createModuleTypes", "createActionTypes"]),
  name: "test-plugin-b",
})

function validateParams(params: any, schema: CustomObjectSchema) {
  validateSchema(
    params,
    schema.keys({
      graph: joi.object(),
    })
  )
}
