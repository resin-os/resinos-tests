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

const Bluebird = require('bluebird')
const path = require('path')
const visuals = require('resin-cli-visuals')
const os = require('os')

const fs = Bluebird.promisifyAll(require('fs'))
const keygen = Bluebird.promisify(require('ssh-keygen'))
const resin = require('resin-sdk')({
  apiUrl: 'https://api.resin.io/'
})
const utils = require('../../utils')

exports.sshHostOS = async (command, uuid, privateKeyPath) => {
  const SSH_HOST = 'ssh.resindevice.io'
  const options = [ '-p 22', `${await resin.auth.whoami()}@${SSH_HOST}`, `host ${uuid}` ]
  return utils.ssh(command, privateKeyPath, options)
}

exports.getAllSupportedOSVersions = (deviceType) => {
  return resin.models.os.getSupportedVersions(deviceType).get('versions')
}

exports.downloadDeviceTypeOS = async (deviceType, version, destination) => {
  const stream = await resin.models.os.download(deviceType, version)
  if (!process.env.CI) {
    const bar = new visuals.Progress('Download')
    stream.on('progress', (data) => {
      bar.update({
        percentage: data.percentage,
        eta: data.eta
      })
    })
  }

  return new Bluebird((resolve, reject) => {
    const output = fs.createWriteStream(destination)
    output.on('error', reject)
    stream.on('error', reject)
    stream.on('finish', resolve)
    stream.pipe(output)
  })
}

exports.getApplicationOSConfiguration = (application, options) => {
  return resin.models.os.getConfig(application, options)
}

exports.getDeviceOSConfiguration = async (uuid, apiKey, options) => {
  const application = await resin.models.device.getApplicationName(uuid)
  const configuration = await exports.getApplicationOSConfiguration(application, options)
  const device = await resin.models.device.get(uuid)

  configuration.registered_at = Math.floor(Date.now() / 1000)
  configuration.deviceId = device.id
  configuration.uuid = uuid
  configuration.deviceApiKey = apiKey
  return configuration
}

exports.getApplicationGitRemote = async (application) => {
  const repo = (await resin.models.application.get(application).get('git_repository'))
  const config = await resin.models.config.getAll()
  const user = await resin.auth.whoami()
  return `${user}@${config.gitServerUrl}:${repo}.git`
}

exports.loginWithCredentials = (credentials) => {
  return resin.auth.login(credentials)
}

exports.logout = () => {
  return resin.auth.logout()
}

exports.hasApplication = (application) => {
  return resin.models.application.has(application)
}

exports.removeApplication = (application) => {
  return exports.hasApplication(application).then((hasApplication) => {
    if (hasApplication) {
      return resin.models.application.remove(application)
    }

    return Bluebird.resolve()
  })
}

exports.createApplication = (name, deviceType) => {
  return resin.models.application.create(name, deviceType)
}

exports.getApplicationDevices = (application) => {
  return resin.models.device.getAllByApplication(application).map((device) => {
    return device.id
  })
}

exports.createSSHKey = async () => {
  const sshDir = path.join(os.homedir(), '.ssh')
  await fs.mkdirAsync(sshDir).catch({
    code: 'EEXIST'
  }, this.noop)

  const privateKeyPath = path.join(sshDir, 'id_rsa')
  const key = await keygen({
    location: privateKeyPath
  })

  await resin.models.key.create('resinOSTests', key.pubKey)

  return {
    privateKey: key.key,
    publicKey: key.pubKey,
    privateKeyPath
  }
}

exports.removeSSHKeys = () => {
  return resin.models.key.getAll().each((key) => {
    return resin.models.key.remove(key.id)
  })
}

exports.isDeviceOnline = (device) => {
  return resin.models.device.isOnline(device)
}

exports.getDeviceHostOSVersion = (device) => {
  return resin.models.device.get(device).get('os_version')
}

exports.getDeviceCommit = (device) => {
  return resin.models.device.get(device).get('is_on__commit')
}

exports.createDevicePlaceholder = async (application) => {
  const applicationId = await resin.models.application.get(application).get('id')
  const uuid = await resin.models.device.generateUniqueKey()
  const deviceApiKey = await resin.models.device.generateUniqueKey()
  await resin.models.device.register(applicationId, uuid, deviceApiKey)
  return {
    uuid,
    deviceApiKey
  }
}

exports.getDeviceStatus = (device) => {
  return resin.models.device.get(device).get('status')
}