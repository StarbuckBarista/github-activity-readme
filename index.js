const core = require("@actions/core");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { Toolkit } = require("actions-toolkit");
const { Octokit } = require("@octokit/core");

// Get config
const GH_USERNAME = core.getInput("GH_USERNAME");
const HTML_ENCODING = core.getInput("HTML_ENCODING");
const COMMIT_MSG = core.getInput("COMMIT_MSG");
const MAX_LINES = core.getInput("MAX_LINES");
/**
 * Returns the sentence case representation
 * @param {String} str - the string
 *
 * @returns {String}
 */

const capitalize = (str) => str.slice(0, 1).toUpperCase() + str.slice(1);

const urlPrefix = "https://github.com";

/**
 * Returns a URL in markdown format for PR's and issues
 * @param {Object | String} item - holds information concerning the issue/PR
 *
 * @returns {String}
 */

const toUrlFormat = (item) => {
  if (HTML_ENCODING === "false") {
    if (typeof item === "object") {
      return Object.hasOwnProperty.call(item.payload, "issue")
        ? `[#${item.payload.issue.number}](${urlPrefix}/${item.repo.name}/issues/${item.payload.issue.number})`
          : `[#${item.payload.pull_request.number}](${urlPrefix}/${item.repo.name}/pull/${item.payload.pull_request.number})`;
    }
    return `[${item}](${urlPrefix}/${item})`;
  } else {
      if (typeof item === "object") {
          return Object.hasOwnProperty.call(item.payload, "issue")
              ? `<a href="${urlPrefix}/${item.repo.name}/issues/${item.payload.issue.number}">#${item.payload.issue.number}</a>`
              : `<a href="${urlPrefix}/${item.repo.name}/pull/${item.payload.pull_request.number}">#${item.payload.pull_request.number}</a>`;
      }
      return `<a href="${urlPrefix}/${item}">${item}</a>`;
  }
};

/**
 * Execute shell command
 * @param {String} cmd - root command
 * @param {String[]} args - args to be passed along with
 *
 * @returns {Promise<void>}
 */

const exec = (cmd, args = []) =>
  new Promise((resolve, reject) => {
    const app = spawn(cmd, args, { stdio: "pipe" });
    let stdout = "";
    app.stdout.on("data", (data) => {
      stdout = data;
    });
    app.on("close", (code) => {
      if (code !== 0 && !stdout.includes("nothing to commit")) {
        err = new Error(`Invalid status code: ${code}`);
        err.code = code;
        return reject(err);
      }
      return resolve(code);
    });
    app.on("error", reject);
  });

/**
 * Make a commit
 *
 * @returns {Promise<void>}
 */

const commitFile = async () => {
  await exec("git", [
    "config",
    "--global",
    "user.email",
    "41898282+github-actions[bot]@users.noreply.github.com",
  ]);
  await exec("git", ["config", "--global", "user.name", "readme-bot"]);
  await exec("git", ["add", "README.md"]);
  await exec("git", ["commit", "-m", COMMIT_MSG]);
  await exec("git", ["push"]);
};

const serializers = {

  IssueCommentEvent: (item) => {

    const image = '<img alt="Commented on" height="24px" valign="bottom" src="./icons/activities/commented_on.png">';
    return ` ${image}  Issue ${toUrlFormat(item)} in ${toUrlFormat(item.repo.name)}`;
  },

  IssuesEvent: (item) => {

    const image = `<img alt="${capitalize(item.payload.action)}" height="24px" valign="bottom" src="./icons/activities/${item.payload.action}_issue.png">`
    return ` ${image}  Issue ${toUrlFormat(item)} in ${toUrlFormat(item.repo.name)}`;
  },

  PullRequestEvent: (item) => {

    let image = `<img alt="${capitalize(item.payload.action)}" height="24px" valign="bottom" src="./icons/activities/${item.payload.action}_pull_request.png">`
    if (item.payload.pull_request.merged) image = '<img alt="Merged" height="24px" valign="bottom" src="./icons/activities/merged_pull_request.png">';
    return ` ${image}  PR ${toUrlFormat(item)} in ${toUrlFormat(item.repo.name)}`;
  },
};

Toolkit.run(
  async (tools) => {

    tools.log.debug(`Getting Activity for ${GH_USERNAME}`);

    const octokit = new Octokit({ auth: process.env.ACCESS_TOKEN });
    const newEvents = await octokit.request("GET /users/{username}/events", {
        username: GH_USERNAME,
        per_page: 100
    });

    const activtyEvents = await octokit.request("GET /repos/{owner}/{repo}/actions/variables/{name}", {
        owner: GH_USERNAME,
        repo: GH_USERNAME,
        name: "ACTIVITY_EVENTS"
    });

    const events = newEvents.data.concat(JSON.parse(activtyEvents.data.value));

    tools.log.debug(`Activity for ${GH_USERNAME}, ${events.length} Events Found.`);

    const processedContent = events
      .filter((event) => serializers.hasOwnProperty(event.type))
      .slice(0, MAX_LINES);

    tools.log.debug(`Activity for ${GH_USERNAME}, ${processedContent.length} Events Processed.`);

    let content = [];

    for (const activity of processedContent) {

      const id = activity.id;
      const found = content.some((uniqueActivity) => uniqueActivity.id === id);
      if (!found) { content.push(activity); }
    }
    
    let cleanedContent = [];

    for (activity of content.slice(0, MAX_LINES)) {

        let payload = {};

        if (activity.type === "IssuesEvent") payload = { "action": activity.payload.action }
        else if (activity.type === "PullRequestEvent") {
            payload = {
                "action": activity.payload.action,
                "pull_request": { "merged": activity.payload.pull_request.merged }
            }
        }

        const cleanedActivity = {
            "id": activity.id,
            "type": activity.type,
            "repo": { "name": activity.repo.name },
            "payload": payload
        };

        cleanedContent.push(cleanedActivity);
    }

    content = content.map((item) => serializers[item.type](item));

    await octokit.request("PATCH /repos/{owner}/{repo}/actions/variables/{name}", {
        owner: GH_USERNAME,
        repo: GH_USERNAME,
        name: "ACTIVITY_EVENTS",
        value: JSON.stringify(cleanedContent)
    });

    const readmeContent = fs.readFileSync("./README.md", "utf-8").split("\n");

    let startIdx = readmeContent.findIndex((content) => content.trim() === "<!--START_SECTION:activity-->");
    if (startIdx === -1) return tools.exit.failure(`Couldn't Find the <!--START_SECTION:activity--> Comment. Exiting!`);
    const endIdx = readmeContent.findIndex((content) => content.trim() === "<!--END_SECTION:activity-->");

    if (!content.length) tools.exit.failure("No PullRequest/Issue/IssueComment Events Found");
    if (content.length < MAX_LINES) tools.log.info(`Found Less Than ${MAX_LINES} Activities`);

    if (startIdx !== -1 && endIdx === -1) {

      const markdownSpliceText = `${idx + 1}. ${line}`;
      let spliceText;

      if (HTML_ENCODING === "false") spliceText = markdownSpliceText;
      else spliceText = `<p align="left">${markdownSpliceText}</p>`

      startIdx++;
      content.forEach((line, idx) => readmeContent.splice(startIdx + idx, 0, spliceText));
      readmeContent.splice(startIdx + content.length, 0, "<!--END_SECTION:activity-->");

      fs.writeFileSync("./README.md", readmeContent.join("\n"));

      try { await commitFile(); } 
      catch (err) {

        tools.log.debug("Something Went Wrong");
        return tools.exit.failure(err);
      }

      tools.exit.success("Wrote to README");
    }

    const oldContent = readmeContent.slice(startIdx + 1, endIdx).join("\n");
    const newMarkdownContent = content
      .map((line, idx) => `${idx + 1}. ${line}`)
      .join("\n");

    let newContent

    if (HTML_ENCODING === "false") newContent = newMarkdownContent;
    else newContent = `<p align="left">${newMarkdownContent}</p>`

    if (oldContent.trim() === newContent.trim()) tools.exit.success("No Changes Detected");
    startIdx++;

    const readmeActivitySection = readmeContent.slice(startIdx, endIdx);
    if (!readmeActivitySection.length) {

      content.some((line, idx) => {

        if (!line) return true;
        const markdownSpliceText = `${idx + 1}. ${line}`;
        let spliceText;

        if (HTML_ENCODING === "false") spliceText = markdownSpliceText;
        else spliceText = `<p align="left">${markdownSpliceText}</p>`

        readmeContent.splice(startIdx + idx, 0, spliceText);
      });

      tools.log.success("Wrote to README");
    } else {
    
      let count = 0;

      readmeActivitySection.some((line, idx) => {

        if (!content[count]) return true;

        if (line !== "") {

          const markdownReadmeContentText = `${count + 1}. ${content[count]}`
          let readmeContentText;

          if (HTML_ENCODING === "false") readmeContentText = markdownReadmeContentText;
          else readmeContentText = `<p align="left">${markdownReadmeContentText}</p>`

          readmeContent[startIdx + idx] = readmeContentText;
          count++;
        }
      });

      tools.log.success("Updated README with the Recent Activity");
    }

    fs.writeFileSync("./README.md", readmeContent.join("\n"));

    try { await commitFile(); } 
    catch (err) {

      tools.log.debug("Something Went Wrong");
      return tools.exit.failure(err);
    }

    tools.exit.success("Pushed to Remote Repository");
  },
  {
    event: ["schedule", "workflow_dispatch"],
    secrets: ["ACCESS_TOKEN"],
  }
);
