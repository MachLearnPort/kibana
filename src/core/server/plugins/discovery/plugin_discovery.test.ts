/*
 * Licensed to Elasticsearch B.V. under one or more contributor
 * license agreements. See the NOTICE file distributed with
 * this work for additional information regarding copyright
 * ownership. Elasticsearch B.V. licenses this file to you under
 * the Apache License, Version 2.0 (the "License"); you may
 * not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

const mockReaddir = jest.fn();
const mockReadFile = jest.fn();
const mockStat = jest.fn();
jest.mock('fs', () => ({
  readdir: mockReaddir,
  readFile: mockReadFile,
  stat: mockStat,
}));

const mockPackage = new Proxy({ raw: {} as any }, { get: (obj, prop) => obj.raw[prop] });
jest.mock('../../../../utils/package_json', () => ({ pkg: mockPackage }));

import { resolve } from 'path';
import { BehaviorSubject } from 'rxjs';
import { first, map, toArray } from 'rxjs/operators';
import { Config, ConfigService, Env, ObjectToConfigAdapter } from '../../config';
import { getEnvOptions } from '../../config/__mocks__/env';
import { logger } from '../../logging/__mocks__';
import { Plugin } from '../plugin';
import { PluginsConfig } from '../plugins_config';
import { discover } from './plugins_discovery';

const TEST_PLUGIN_SEARCH_PATHS = {
  nonEmptySrcPlugins: resolve(process.cwd(), 'src', 'plugins'),
  emptyPlugins: resolve(process.cwd(), 'plugins'),
  nonExistentKibanaExtra: resolve(process.cwd(), '..', 'kibana-extra'),
};

beforeEach(() => {
  mockReaddir.mockImplementation((path, cb) => {
    if (path === TEST_PLUGIN_SEARCH_PATHS.nonEmptySrcPlugins) {
      cb(null, [
        '1',
        '2-no-manifest',
        '3',
        '4-incomplete-manifest',
        '5-invalid-manifest',
        '6',
        '7-non-dir',
        '8-incompatible-manifest',
        '9-inaccessible-dir',
      ]);
    } else if (path === TEST_PLUGIN_SEARCH_PATHS.nonExistentKibanaExtra) {
      cb(new Error('ENOENT'));
    } else {
      cb(null, []);
    }
  });

  mockStat.mockImplementation((path, cb) =>
    cb(null, { isDirectory: () => !path.includes('non-dir') })
  );

  mockStat.mockImplementation((path, cb) => {
    if (path.includes('9-inaccessible-dir')) {
      cb(new Error(`ENOENT (disappeared between "readdir" and "stat").`));
    } else {
      cb(null, { isDirectory: () => !path.includes('non-dir') });
    }
  });

  mockReadFile.mockImplementation((path, cb) => {
    if (path.includes('no-manifest')) {
      cb(new Error('ENOENT'));
    } else if (path.includes('invalid-manifest')) {
      cb(null, Buffer.from('not-json'));
    } else if (path.includes('incomplete-manifest')) {
      cb(null, Buffer.from(JSON.stringify({ version: '1' })));
    } else if (path.includes('incompatible-manifest')) {
      cb(null, Buffer.from(JSON.stringify({ id: 'plugin', version: '1' })));
    } else {
      cb(
        null,
        Buffer.from(
          JSON.stringify({
            id: 'plugin',
            configPath: ['core', 'config'],
            version: '1',
            kibanaVersion: '1.2.3',
            requiredPlugins: ['a', 'b'],
            optionalPlugins: ['c', 'd'],
          })
        )
      );
    }
  });
});

afterEach(() => {
  jest.clearAllMocks();
});

test('properly iterates through plugin search locations', async () => {
  mockPackage.raw = {
    branch: 'master',
    version: '1.2.3',
    build: {
      distributable: true,
      number: 1,
      sha: '',
    },
  };

  const env = Env.createDefault(getEnvOptions());
  const configService = new ConfigService(
    new BehaviorSubject<Config>(new ObjectToConfigAdapter({})),
    env,
    logger
  );

  const pluginsConfig = await configService
    .atPath('plugins', PluginsConfig)
    .pipe(first())
    .toPromise();
  const { plugin$, error$ } = discover(pluginsConfig, { configService, env, logger });

  const plugins = await plugin$.pipe(toArray()).toPromise();
  expect(plugins).toHaveLength(3);

  for (const path of [
    resolve(TEST_PLUGIN_SEARCH_PATHS.nonEmptySrcPlugins, '1'),
    resolve(TEST_PLUGIN_SEARCH_PATHS.nonEmptySrcPlugins, '3'),
    resolve(TEST_PLUGIN_SEARCH_PATHS.nonEmptySrcPlugins, '6'),
  ]) {
    const discoveredPlugin = plugins.find(plugin => plugin.path === path)!;
    expect(discoveredPlugin).toBeInstanceOf(Plugin);
    expect(discoveredPlugin.configPath).toEqual(['core', 'config']);
    expect(discoveredPlugin.requiredDependencies).toEqual(['a', 'b']);
    expect(discoveredPlugin.optionalDependencies).toEqual(['c', 'd']);
  }

  await expect(
    error$
      .pipe(
        map(error => error.toString()),
        toArray()
      )
      .toPromise()
  ).resolves.toEqual([
    `Error: ENOENT (disappeared between "readdir" and "stat"). (invalid-plugin-path, ${resolve(
      TEST_PLUGIN_SEARCH_PATHS.nonEmptySrcPlugins,
      '9-inaccessible-dir'
    )})`,
    `Error: ENOENT (invalid-search-path, ${TEST_PLUGIN_SEARCH_PATHS.nonExistentKibanaExtra})`,
    `Error: ENOENT (missing-manifest, ${resolve(
      TEST_PLUGIN_SEARCH_PATHS.nonEmptySrcPlugins,
      '2-no-manifest',
      'kibana.json'
    )})`,
    `Error: Plugin manifest must contain an "id" property. (invalid-manifest, ${resolve(
      TEST_PLUGIN_SEARCH_PATHS.nonEmptySrcPlugins,
      '4-incomplete-manifest',
      'kibana.json'
    )})`,
    `Error: Unexpected token o in JSON at position 1 (invalid-manifest, ${resolve(
      TEST_PLUGIN_SEARCH_PATHS.nonEmptySrcPlugins,
      '5-invalid-manifest',
      'kibana.json'
    )})`,
    `Error: Plugin "plugin" is only compatible with Kibana version "1", but used Kibana version is "1.2.3". (incompatible-version, ${resolve(
      TEST_PLUGIN_SEARCH_PATHS.nonEmptySrcPlugins,
      '8-incompatible-manifest',
      'kibana.json'
    )})`,
  ]);
});
