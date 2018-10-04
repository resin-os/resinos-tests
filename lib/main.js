/*
 * Copyright 2017 resin.io
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict'

const _ = require('lodash')
const AJV = require('ajv')
const Bluebird = require('bluebird')
const fse = require('fs-extra')
const fs = Bluebird.promisifyAll(require('fs'))
const Store = require('data-store')

const QEMUWorker = require('./workers/qemu')
const ManualWorker = require('./workers/manual')

const store = new Store(process.env.DATA_STORE, {
  base: process.env.DATA_STORE_PATH
})

const options = store.get('options')

fse.ensureDirSync(options.tmpdir)

const utils = require('./utils')
const Resinio = utils.requireComponent('resinio', 'sdk')
const Resinos = utils.requireComponent('os', 'resinos')
const deviceTypeContract = require(`../contracts/contracts/hw.device-type/${options.deviceType}.json`)

const resinio = new Resinio(options.resinUrl)

const context = {
  uuid: null,
  key: null,
  dashboardUrl: null,
  os: null,
  worker: null,
  deviceType: deviceTypeContract
}

const results = {
  author: null,
  deviceType: options.deviceType,
  provisionTime: null,
  imageSize: null,
  resinOSVersion: options.resinOSVersion
}

const setup = async () => {
  console.log('Logging into resin.io')
  await resinio.loginWithToken(options.apiKey)

  console.log(`Creating application: ${options.applicationName} with device type ${options.deviceType}`)
  await resinio.createApplication(options.applicationName, options.deviceType)

  context.key = await resinio.createSSHKey(options.sshKeyLabel)
  console.log(`Add new SSH key: ${context.key.publicKey} with label: ${options.sshKeyLabel}`)
  if (options.delta) {
    console.log('Enabling deltas')
    await resinio.createEnvironmentVariable(options.applicationName, 'RESIN_SUPERVISOR_DELTA', options.delta)
  }

  console.log(`Creating device placeholder on ${options.applicationName}`)
  const placeholder = await resinio.createDevicePlaceholder(options.applicationName)

  console.log(`Getting resin.io configuration for device ${placeholder.uuid}`)
  const resinConfiguration = await resinio.getDeviceOSConfiguration(
    placeholder.uuid, placeholder.deviceApiKey, _.assign({
      version: options.resinOSVersion
    }, options.configuration)
  )

  context.os = new Resinos({
    tmpdir: options.tmpdir,
    configuration: resinConfiguration,
    deviceType: options.deviceType,
    version: options.resinOSVersion,
    url: options.resinStagingUrl
  })

  await context.os.fetch()

  // FIXME this should be extracted out
  if (options.deviceType === 'qemux86-64') {
    context.worker = new QEMUWorker('main worker', deviceTypeContract)
  } else {
    context.worker = new ManualWorker('main worker', deviceTypeContract, {
      devicePath: options.disk
    })
  }

  await context.worker.ready()
  await context.worker.flash(context.os)
  await context.worker.on()

  console.log('Waiting while device boots')
  await utils.waitUntil(() => {
    return resinio.isDeviceOnline(placeholder.uuid)
  })
  context.uuid = placeholder.uuid

  console.log('Waiting while supervisor starts')
  await utils.waitUntil(async () => {
    return await resinio.getDeviceStatus(placeholder.uuid) === 'Idle'
  })

  const uptime = await utils.getDeviceUptime((command) => {
    return resinio.sshHostOS(command, context.uuid, context.key.privateKeyPath)
  })

  console.log('Gathering metrics')
  results.imageSize = `${(await fs.statAsync(await fs.realpathAsync(context.os.image))).size / 1048576.0} Mb`
  results.provisionTime = `${Math.floor(uptime / 60)}m ${Math.floor(uptime % 60)}s`
  results.email = await resinio.getEmail()

  console.log('Running tests:')
  context.dashboardUrl = await resinio.getDashboardUrl(context.uuid)
}

const main = async () => {
  await setup()

  const tap = require('tap')

  tap.tearDown(async () => {
    await context.worker.off()

    store.set({
      results
    })
  })

  if (options.interactiveTests) {
    // TODO: These should be tested as provisioning variants
    // Allow the user to set image maker configuration options as env vars.
    if (options.deviceType === 'ts4900') {
      tap.test(`${options.deviceType}: Provision single model`, async (test) => {
        tap.resolveMatch(utils.runManualTestCase({
          do: [
            'Go into an existing ts4900 app or create a new one',
            'Select "single" as "CPU Cores"',
            'Select any "Network Connection" option',
            'Download the image and boot a single core variant of TS4900'
          ],
          assert: [ 'The device should successfully get provisioned and appear in dashboard' ]
        }), true)
      })

      tap.test(`${options.deviceType}: Provision quad model`, async (test) => {
        test.resolveMatch(utils.runManualTestCase({
          do: [
            'Go into an existing ts4900 app or create a new one',
            'Select "quad" as "CPU Cores"',
            'Select any "Network Connection" option',
            'Download the image and boot a single core variant of TS4900'
          ],
          assert: [ 'The device should successfully get provisioned and appear in dashboard' ]
        }), true)
      })
    }
  }

  _.each([
    require('../tests/bluetooth-test'),
    require('../tests/device-online'),
    require('../tests/device-reportOsVersion'),
    require('../tests/enter-container'),
    require('../tests/hdmi-uart5'),
    require('../tests/hostapp-update'),
    require('../tests/identification-led'),
    require('../tests/kernel-splash-screen'),
    require('../tests/os-file-format'),
    require('../tests/push-container'),
    require('../tests/push-multicontainer'),
    require('../tests/reboot-with-app'),
    require('../tests/update-supervisor-through-api'),
    require('../tests/reload-supervisor'),
    require('../tests/resin-device-progress'),
    require('../tests/resin-splash-screen'),
    require('../tests/resin-sync'),
    require('../tests/rpi-serial-uart0'),
    require('../tests/rpi-serial-uart1'),
    require('../tests/service-variables')
  ], (testCase) => {
    if (testCase.interactive && !options.interactiveTests) {
      return
    }

    if (testCase.deviceType) {
      const ajv = new AJV()
      if (!ajv.compile(testCase.deviceType)(deviceTypeContract)) {
        return
      }
    }

    tap.test(_.template(testCase.title)({
      options
    }), (test) => {
      console.log(`Starting Test: ${test.name}`)
      return testCase.run(test, context, options, {
        resinio
      }).catch(test.threw)
    })
  })
}

main()
  .catch(async (err) => {
    console.error(err)
    process.exitCode = 1

    await context.worker.off()
  })