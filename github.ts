import { App, Octokit } from "octokit";
import fs from "fs";
import axios from "axios";
import { PRWebhookPayload } from "../utils/types.js";
import { extractCleanCodeFromDiff } from "../utils/utils.js";
import { config } from "../config/index.js";
import { parseCode } from "./code-parser-service.js";
import { generateCodeFeedback, generateFollowUpResponse } from "./ai-service.js";
import { callGPT, preparePrompt } from "./simulated-ai-service.js";

// Read the private key for GitHub App authentication.
const privateKey = fs.readFileSync(config.privateKeyPath!, "utf8");

// Create an instance of the GitHub App.
const app: App = new App({
  appId: config.appId!,
  privateKey: privateKey,
  webhooks: {
    secret: config.webhookSecret,
  },
});

/**
 * Fetches the changed files data of a pull request.
 * @param octokit - Authenticated Octokit instance.
 * @param owner - Repository owner.
 * @param repo - Repository name.
 * @param pull_number - Pull request number.
 * @returns Array of changed files data.
 */
async function fetchChangedFilesData(
  octokit: Octokit,
  owner: string,
  repo: string,
  pull_number: number
): Promise<any[]> {
  const { data: files } = await octokit.rest.pulls.listFiles({
    owner,
    repo,
    pull_number,
    per_page: 100,
  });

  return files.map((file) => ({
    filename: file.filename,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    changes: file.changes,
    patch: file.patch, // patch may be undefined for binary files
  }));
}

/**
 * Fetches the full content of a given file in a repository.
 * @param octokit - Authenticated Octokit instance.
 * @param owner - Repository owner.
 * @param repo - Repository name.
 * @param path - File path within the repository.
 * @returns The file's raw content as a string.
 */
export async function fetchFullFileContent(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string
): Promise<string> {
  // Request the file content from GitHub using raw media type.
  const response = await octokit.rest.repos.getContent({
    owner,
    repo,
    path,
    mediaType: {
      format: "raw",
    },
  });

  // If the response data is a string, return it directly.
  if (typeof response.data === "string") {
    return response.data;
  }

  // If the response data is an array, it means a directory was returned.
  if (Array.isArray(response.data)) {
    throw new Error(
      `Expected a file but received a directory for path: ${path}`
    );
  }

  // If the response data is an object representing a file, check if it has a 'content' property.
  if (response.data.type === "file" && response.data.content) {
    // Decode the Base64 encoded content to a UTF-8 string.
    return Buffer.from(response.data.content, "base64").toString("utf8");
  }

  // If none of the above conditions are met, throw an error.
  throw new Error(`Unable to fetch file content as string for path: ${path}`);
}

/**
 * Aggregates the AST and raw code for each changed file.
 * @param octokit - Authenticated Octokit instance.
 * @param owner - Repository owner.
 * @param repo - Repository name.
 * @param changedFilesData - Array of changed files data.
 * @returns An object containing both the aggregated raw code and AST report.
 */
async function aggregateASTReport(
  // octokit: Octokit,
  owner: string,
  repo: string,
  changedFilesData: any[]
): Promise<{ rawCode: string; astReport: string }> {
  let rawCode = "";
  let astReport = "";
  for (const file of changedFilesData) {
    try {
      // Fetch the full content for each changed file.
      const content = await fetchFullFileContent(
        octokit,
        owner,
        repo,
        file.filename
      );
      rawCode += `### ${file.filename}\n\`\`\`\n${content}\n\`\`\`\n\n`;

      // Parse the full content using Tree-sitter.
      const tree = parseCode(content);
      const astString = tree.rootNode.toString();
      astReport += `### ${file.filename}\n\`\`\`\n${astString}\n\`\`\`\n\n`;
    } catch (error) {
      console.error(`Error processing file ${file.filename}:`, error);
    }
  }
  return { rawCode, astReport };
}

/**
 * Posts a comment on a pull request.
 * @param octokit - Authenticated Octokit instance.
 * @param owner - Repository owner.
 * @param repo - Repository name.
 * @param issue_number - Issue or pull request number.
 * @param body - Comment body.
 */
async function postComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  issue_number: number,
  body: string
): Promise<void> {
  await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number,
    body,
    headers: {
      "x-github-api-version": "2022-11-28",
    },
  });
}

/**
 * Handles a pull request event by fetching changed file data,
 * aggregating full file contents and their AST reports, preparing an AI prompt,
 * and posting AI-generated feedback as a comment on the PR.
 * @param payload - The pull request webhook payload.
 */
export async function handlePullRequestEvent(
  payload: PRWebhookPayload
): Promise<void> {
  const octokit = await app.getInstallationOctokit(payload.installation.id);
  const owner: string = payload.repository.owner.login;
  const repo: string = payload.repository.name;
  const pull_number: number = payload.pull_request?.number ?? 0;

  try {
    // Retrieve changed files data from the pull request.
    const changedFilesData = await fetchChangedFilesData(
      octokit,
      owner,
      repo,
      pull_number
    );

    // Aggregate raw code and AST report from changed files.
    const { rawCode, astReport } = await aggregateASTReport(
      octokit,
      owner,
      repo,
      changedFilesData
    );

    // Get AI-generated feedback using the simulated AI service.
    const feedback = await generateCodeFeedback(
      changedFilesData,
      rawCode,
      astReport
    );

    // Post the generated feedback as a comment on the pull request.
    await postComment(octokit, owner, repo, pull_number, feedback);
    console.log(`Posted feedback comment on PR #${pull_number}`);
  } catch (error: unknown) {
    if (error instanceof Error) {
      console.error(`Error handling PR event: ${error.message}`);
    }
    throw error;
  }
}

/**
 * Handles a pull request comment event by responding to the user's comment
 * with an AI-generated response that takes into account the context of the PR.
 * @param payload - The pull request comment webhook payload.
 */
export async function handlePullRequestCommentEvent(
  payload: PRWebhookPayload): Promise<void> {
  console.log('Handling a pull request comment event.');
  const octokit = await app.getInstallationOctokit(payload.installation.id);
  const owner: string = payload.repository.owner.login;
  const repo: string = payload.repository.name;
  const pull_number: number = payload.issue?.number ?? 0;
  const userComment: string = payload.comment?.body ?? '';

  try {

    // Get PR details and context
    const { data: pullRequest } = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number
    });

    // Grab previous comments for context
    const { data: comments } = await octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number: pull_number
    });

    // Retrieve changed files data from the pull request.
    const changedFilesData = await fetchChangedFilesData(
      octokit,
      owner,
      repo,
      pull_number
    );

    // Aggregate raw code and AST report from changed files.
    const { rawCode, astReport } = await aggregateASTReport(
      octokit,
      owner,
      repo,
      changedFilesData
    );

    // Format previous comments for context
    const previousComments = comments
      .slice(-30) // Only include the last 30 comments for brevity
      .map(comment => {
        const isBot = comment.user?.login === 'pga-github-app';
        const prefix = isBot ? '[BOT RESPONSE]' : '[USER]';
        const username = comment.user?.login || 'unknown';
        const body = comment.body?.substring(0, 500) || '';
        const ellipsis = comment.body?.length && comment.body?.length > 500 ? '...' : '';
        
        return `${prefix} ${username}: ${body}${ellipsis}`;
      })      .join('\n\n');

    // Get AI generated follow up response to the user's comment
    const followUpResponse = await generateFollowUpResponse(
      pullRequest,
      userComment,
      previousComments,
      changedFilesData,
      rawCode,
      astReport
    );


    // Post the generated feedback as a comment on the pull request.
    await postComment(octokit, owner, repo, pull_number, followUpResponse);
    console.log(`Posted follow up comment on PR #${pull_number}`);

  } catch (error: unknown) {
    if (error instanceof Error) {
      console.error(`Error handling PR event: ${error.message}`);
    }
    throw error;
  }
}
