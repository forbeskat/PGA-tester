# PGA-tester
This is march 26th and hopefully this shows up as the text in the diff of the files
const diffText = response.data;
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


Update test


ljkjhjkh
