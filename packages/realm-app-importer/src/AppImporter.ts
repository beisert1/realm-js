////////////////////////////////////////////////////////////////////////////
//
// Copyright 2020 Realm Inc.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//
////////////////////////////////////////////////////////////////////////////

import cp from "child_process";
import fetch from "node-fetch";
import path from "path";
import fs from "fs-extra";
import glob from "glob";
import deepmerge from "deepmerge";

/**
 * First level keys are file globs and the values are objects that are spread over the content of the files matching the glob.
 * @example { "config.json": { name: "overridden-name" }, "services/local-mongodb/rules/*.json": { database: "another-database" } }
 */
export type TemplateReplacements = Record<string, Record<string, unknown>>;

/* eslint-disable no-console */

export type Credentials =
  | {
      kind: "api-key";
      publicKey: string;
      privateKey: string;
    }
  | {
      kind: "username-password";
      username: string;
      password: string;
    };

export interface AppImporterOptions {
  baseUrl: string;
  credentials: Credentials;
  realmConfigPath: string;
  appsDirectoryPath: string;
  cleanUp?: boolean;
}

type App = {
  _id: string;
  client_app_id: string;
  name: string;
  location: string;
  deployment_model: string;
  domain_id: string;
  group_id: string;
  last_used: number;
  last_modified: number;
  product: string;
  environment: string;
};

export class AppImporter {
  private readonly baseUrl: string;
  private readonly credentials: Credentials;
  private readonly realmConfigPath: string;
  private readonly appsDirectoryPath: string;

  private accessToken: string | undefined;

  constructor({ baseUrl, credentials, realmConfigPath, appsDirectoryPath, cleanUp = true }: AppImporterOptions) {
    this.baseUrl = baseUrl;
    this.credentials = credentials;
    this.realmConfigPath = realmConfigPath;
    this.appsDirectoryPath = appsDirectoryPath;

    if (cleanUp) {
      process.on("exit", () => {
        // Remove any stitch configuration
        if (fs.existsSync(this.realmConfigPath)) {
          console.log(`Deleting ${this.realmConfigPath}`);
          fs.removeSync(this.realmConfigPath);
        }
        // If there is nothing the the apps directory, lets delete it
        if (fs.existsSync(this.appsDirectoryPath)) {
          console.log(`Deleting ${this.appsDirectoryPath}`);
          fs.removeSync(this.appsDirectoryPath);
        }
      });
    }
  }

  /**
   * @param appTemplatePath The path to a template directory containing the configuration files needed to import the app.
   * @param replacements An object with file globs as keys and a replacement object as values. Allows for just-in-time replacements of configuration parameters.
   * @returns A promise of an object containing the app id.
   */
  public async importApp(appTemplatePath: string, replacements: TemplateReplacements = {}): Promise<{ appId: string }> {
    const { name: appName } = this.loadAppConfigJson(appTemplatePath);
    await this.logIn();
    const groupId = await this.getGroupId();

    // Get or create an application
    const app = await this.createApp(groupId, appName);
    const appId = app.client_app_id as string;
    // Create all secrets in parallel
    const secrets = this.loadSecretsJson(appTemplatePath);
    await Promise.all(
      Object.entries<string>(secrets).map(async ([name, value]) => {
        if (typeof value !== "string") {
          throw new Error(`Expected a secret string value for '${name}'`);
        }
        return this.createSecret(groupId, app._id, name, value);
      }),
    );

    // Determine the path of the new app
    const appPath = path.resolve(this.appsDirectoryPath, appId);
    // Copy over the app template
    this.copyAppTemplate(appPath, appTemplatePath);
    // Apply any replacements to the files before importing from them
    this.applyReplacements(appPath, replacements);

    // Import
    this.realmCli(
      "import",
      "--config-path",
      this.realmConfigPath,
      "--base-url",
      this.baseUrl,
      "--app-name",
      appName,
      "--app-id",
      appId,
      "--path",
      appPath,
      "--project-id",
      groupId,
      "--strategy",
      "replace",
      "--yes", // Bypass prompts
    );

    // Return the app id of the newly created app
    return { appId };
  }

  public async deleteApp(clientAppId: string): Promise<void> {
    await this.logIn();
    const groupId = await this.getGroupId();

    const app = await this.getAppByClientAppId(groupId, clientAppId);
    const url = `${this.baseUrl}/api/admin/v3.0/groups/${groupId}/apps/${app._id}`;

    const response = await fetch(url, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "content-type": "application/json",
      },
    });
    if (!response.ok) {
      throw new Error(`Failed to delete app with client app ID '${clientAppId}' in group '${groupId}'`);
    }
  }

  private get apiUrl() {
    return `${this.baseUrl}/api/admin/v3.0`;
  }

  private loadJson(filePath: string) {
    try {
      const content = fs.readFileSync(filePath, "utf8");
      return JSON.parse(content);
    } catch (err) {
      throw new Error(`Failed to load JSON (${filePath}): ${(err as Error).message}`);
    }
  }

  private loadAppConfigJson(appTemplatePath: string) {
    const configJsonPath = path.resolve(appTemplatePath, "config.json");
    return this.loadJson(configJsonPath);
  }

  private loadSecretsJson(appTemplatePath: string) {
    const secretsJsonPath = path.resolve(appTemplatePath, "secrets.json");
    if (fs.existsSync(secretsJsonPath)) {
      return this.loadJson(secretsJsonPath);
    } else {
      return {};
    }
  }

  private copyAppTemplate(appPath: string, appTemplatePath: string) {
    // Only copy over the template, if the app doesn't already exist
    if (!fs.existsSync(appPath)) {
      fs.mkdirpSync(appPath);
      fs.copySync(appTemplatePath, appPath, {
        recursive: true,
      });
    }
  }

  private applyReplacements(appPath: string, replacements: TemplateReplacements) {
    for (const [fileGlob, replacement] of Object.entries(replacements)) {
      console.log(`Applying replacements to ${fileGlob}`);
      const files = glob.sync(fileGlob, { cwd: appPath });
      for (const relativeFilePath of files) {
        const filePath = path.resolve(appPath, relativeFilePath);
        const content = fs.readJSONSync(filePath);
        const mergedContent = deepmerge(content, replacement);
        fs.writeJSONSync(filePath, mergedContent, { spaces: 2 });
      }
    }
  }

  private realmCli(...args: string[]) {
    const cliPath = require.resolve("mongodb-realm-cli/wrapper.js");
    cp.execFileSync(cliPath, args, { stdio: "inherit" });
  }

  private performLogIn() {
    const { credentials } = this;
    if (credentials.kind === "api-key") {
      return fetch(`${this.apiUrl}/auth/providers/mongodb-cloud/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          username: credentials.publicKey,
          apiKey: credentials.privateKey,
        }),
      });
    } else if (credentials.kind === "username-password") {
      return fetch(`${this.apiUrl}/auth/providers/local-userpass/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          username: credentials.username,
          password: credentials.password,
        }),
      });
    } else {
      throw new Error(`Unexpected credentials: ${credentials}`);
    }
  }

  private async logIn() {
    // Store the access and refresh tokens
    const response = await this.performLogIn();
    const responseBody = await response.json();
    if (response.ok) {
      this.accessToken = responseBody.access_token;
      // Write the stitch config file
      const { credentials } = this;
      this.saveStitchConfig(
        credentials.kind === "api-key" ? credentials.publicKey : credentials.username,
        responseBody.refresh_token,
        responseBody.access_token,
      );
    } else {
      const message = responseBody.error || "No reason";
      throw new Error(`Failed to log in: ${message}`);
    }
  }

  private saveStitchConfig(username: string, refreshToken: string, accessToken: string) {
    const realmConfig = [
      `public_api_key: ${username}`,
      `refresh_token: ${refreshToken}`,
      `access_token: ${accessToken}`,
    ];
    fs.writeFileSync(this.realmConfigPath, realmConfig.join("\n"), "utf8");
  }

  private async getProfile() {
    if (!this.accessToken) {
      throw new Error("Login before calling this method");
    }
    const url = `${this.baseUrl}/api/admin/v3.0/auth/profile`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });
    if (response.ok) {
      return response.json();
    } else {
      throw new Error("Failed to get users profile");
    }
  }

  private async getGroupId(): Promise<string> {
    const profile = await this.getProfile();
    const groupIds: string[] = profile.roles
      .filter((r: Record<string, unknown>) => r.group_id)
      .map((r: Record<string, unknown>) => r.group_id);
    const uniqueGroupIds = [...new Set(groupIds)];
    if (uniqueGroupIds.length === 1) {
      return uniqueGroupIds[0];
    } else {
      throw new Error("Expected user to have a role in a single group");
    }
  }

  private async getAppByClientAppId(groupId: string, clientAppId: string): Promise<App> {
    if (!this.accessToken) {
      throw new Error("Login before calling this method");
    }
    const url = `${this.baseUrl}/api/admin/v3.0/groups/${groupId}/apps`;
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "content-type": "application/json",
      },
    });
    if (response.ok) {
      const apps: App[] = await response.json();
      const app = apps.find((app) => app.client_app_id === clientAppId);
      if (!app) {
        throw new Error(`App with client app ID '${clientAppId}' in group '${groupId}' not found`);
      }

      return app;
    } else {
      throw new Error(`Failed to find app with client app ID '${clientAppId}' in group '${groupId}'`);
    }
  }

  private async createApp(groupId: string, name: string) {
    if (!this.accessToken) {
      throw new Error("Login before calling this method");
    }
    const url = `${this.baseUrl}/api/admin/v3.0/groups/${groupId}/apps`;
    const body = JSON.stringify({ name });
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "content-type": "application/json",
      },
      body,
    });
    if (response.ok) {
      return response.json();
    } else {
      throw new Error(`Failed to create app named '${name}' in group '${groupId}'`);
    }
  }

  private async createSecret(groupId: string, internalAppId: string, name: string, value: string) {
    console.log(`Creating "${name}" secret`);
    if (!this.accessToken) {
      throw new Error("Login before calling this method");
    }
    const url = `${this.baseUrl}/api/admin/v3.0/groups/${groupId}/apps/${internalAppId}/secrets`;
    const body = JSON.stringify({ name, value });
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "content-type": "application/json",
      },
      body,
    });
    if (!response.ok) {
      throw new Error(`Failed to create secred '${name}'`);
    }
  }
}
