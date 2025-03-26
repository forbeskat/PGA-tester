console.log(diffText);

await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
  owner,
  repo,
  issue_number: pull_number,
  body: messageForNewPRs,
  headers: {
    'x-github-api-version': '2022-11-28',
  },
});
