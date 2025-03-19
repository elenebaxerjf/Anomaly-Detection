import { Octokit } from "@octokit/rest";
import { config } from "dotenv";
import fetch from "node-fetch";
import converter from "currency-exchanger-js";
import { Memory } from "./cache";
import fs from "fs/promises";

config();

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const PROXYCURL_API_KEY = process.env.PROXYCURL_API_KEY;
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
if (!GITHUB_TOKEN || !PROXYCURL_API_KEY || !RAPIDAPI_KEY) {
  throw new Error("Missing required environment variables");
}

const memory = new Memory(".cache", 0);

interface ExpectedResult {
  githubUsername: string;
  reposCount?: number;
  company: string;
  location: string;
  position: string;
  year?: number;
  salaryDollar?: number;
  salaryCurrency?: string;
  salaryPeriod?: string;
  linkedinUsername?: string;
  personalWebsite?: string;
  linkedinType?: "direct" | "inferred"; // New property
}

interface GitHubSearchResult {
  githubUsername: string;
  location?: string;
  linkedinUsername?: string;
  personalWebsite?: string;
  reposCount?: number;
}

interface LinkedinResult {
  company?: string;
  position?: string;
  location?: string[] | string;
  year?: number;
}

/**
 * Convert a given amount from any currency to USD
 */
async function convertToUSD(amount: number, currency: string): Promise<number> {
  return await converter.convert(amount, currency, "usd");
}
const convertToUSDCached = convertToUSD;

/**
 * Search GitHub (repos + users), execute page=1,2 concurrently, and finally return a list of all unique usernames
 */
async function fetchAllGitHubSearch(query: string): Promise<string[]> {
  const octokit = new Octokit({ auth: GITHUB_TOKEN });

  const searchRepo = memory.cache(octokit.search.repos.bind(octokit.search), "octokit.search.repos");
  const searchUser = memory.cache(octokit.search.users.bind(octokit.search), "octokit.search.users");

  // Concurrently fetch four queries using Promise.all
  const [repoPage1, repoPage2, userPage1, userPage2] = await Promise.all([
    searchRepo({ q: query, per_page: 100, page: 1 }),
    searchRepo({ q: query, per_page: 100, page: 2 }),
    searchUser({ q: query, per_page: 100, page: 1 }),
    searchUser({ q: query, per_page: 100, page: 2 }),
  ]);

  const seen = new Set<string>();

  // Collect repo results
  for (const item of [...repoPage1.data.items, ...repoPage2.data.items]) {
    if (item.owner?.login) {
      seen.add(item.owner.login);
    }
  }
  // Collect user results
  for (const user of [...userPage1.data.items, ...userPage2.data.items]) {
    if (user.login) {
      seen.add(user.login);
    }
  }

  return [...seen];
}

/**
 * Call getUserByUsername (Octokit) to get user details, excluding organizations.
 */
async function fetchUsersDetail(usernames: string[]): Promise<GitHubSearchResult[]> {
  const octokit = new Octokit({ auth: GITHUB_TOKEN });
  const getUserByUsername = memory.cache(octokit.users.getByUsername.bind(octokit.users), "octokit.users.getByUsername");

  // Concurrently fetch each user's information using Promise.allSettled
  const results = await Promise.allSettled(
    usernames.map((username) => getUserByUsername({ username }))
  );

  const usersDetail: GitHubSearchResult[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") {
      const user = r.value.data;
      if (user.type === "Organization") {
        // Exclude organizations
        continue;
      }
      const githubUsername = user.login;
      const location = user.location || undefined;
      let linkedinUsername: string | undefined;
      let personalWebsite: string | undefined;

      // If blog contains "linkedin.com/in/"
      if (user.blog && user.blog.includes("linkedin.com/in/")) {
        linkedinUsername = user.blog.split("linkedin.com/in/")[1].split("/")[0];
      } else if (user.blog) {
        personalWebsite = user.blog;
      }

      usersDetail.push({
        githubUsername,
        location,
        linkedinUsername,
        personalWebsite,
        reposCount: user.public_repos,
      });
    } else {
      console.warn("Failed to fetch user data:", r.reason);
    }
  }

  return usersDetail;
}

/**
 * Try to fetch LinkedIn username from personal website
 */
async function getLinkedinFromWebsite(website: string): Promise<string | undefined> {
  try {
    if (!website.startsWith("http")) {
      website = "http://" + website;
    }
    website = new URL(website).href;
    if (!website.startsWith("http://") && !website.startsWith("https://")) {
      throw new Error("Invalid URL");
    }

    const res = await fetch(website);
    const html = await res.text();

    const linkedin = html.match(/linkedin.com\/in\/([^/\s"']+)/);
    if (!linkedin) {
      return undefined;
    }

    return linkedin[1];
  } catch {
    return undefined;
  }
}
const getLinkedinFromWebsiteCached = memory.cache(getLinkedinFromWebsite);


/**
 * Scrape the GitHub profile page HTML for a LinkedIn URL.
 * Returns the LinkedIn username if found.
 */

/**
 * Scrape GitHub pages for a LinkedIn URL.
 * It first checks the user's GitHub profile page, then the /<username> repository page.
 * Returns the LinkedIn username if found.
 */
async function getLinkedinFromGitHub(username: string): Promise<string | undefined> {
  // Define the URLs to check.
  const urlsToCheck = [
    `https://github.com/${username}`,
    `https://github.com/${username}/${username}`,
  ];

  for (const url of urlsToCheck) {
    try {
      const res = await fetch(url);
      if (!res.ok) {
        // If the page doesn't exist or is inaccessible, try the next one.
        continue;
      }
      const html = await res.text();
      // Use a regular expression to search for a LinkedIn URL.
      const match = html.match(/linkedin\.com\/in\/([a-zA-Z0-9\-_\/]+)/);
      if (match && match[1]) {
        return match[1];
      }
    } catch (error) {
      console.warn(`[${username}] Error fetching ${url}: ${error}`);
      // Continue to the next URL if one fails.
    }
  }
  return undefined;
}

const getLinkedinFromGitHubCached = memory.cache(getLinkedinFromGitHub, "getLinkedinFromGitHub");

/**
 * Fetch LinkedIn data using ProxyCurl
 * API docs: https://nubela.co/proxycurl
 */
async function fetchLinkedInData(username: string): Promise<any> {
  const url = `https://nubela.co/proxycurl/api/v2/linkedin?url=https://www.linkedin.com/in/${username}/&use_cache=if-present`;
  const res = await fetch(url, {
    headers: new Headers({
      Authorization: `Bearer ${PROXYCURL_API_KEY}`,
    }),
  });

  if (res.status !== 200) {
    throw new Error(`Failed to fetch LinkedIn data for ${username}: ${res.statusText}`);
  }

  return await res.json();
}
const fetchLinkedInDataCached = memory.cache(fetchLinkedInData);

/**
 * Parse LinkedIn result to extract company, position, location, and years of experience
 */
async function getLinkedInData(username: string): Promise<LinkedinResult> {
  try {
    const data = await fetchLinkedInDataCached(username);

    const lastExperience = data.experiences?.[0];
    if (!lastExperience) {
      // Indicates that no experience was fetched from LinkedIn
      return {};
    }

    const company = lastExperience.company;
    const position = lastExperience.title;

    function findLocation(): string[] {
      const loc: string[] = [];
      if (data.city) loc.push(data.city);
      if (data.state) loc.push(data.state);
      if (data.country_full_name) loc.push(data.country_full_name);
      if (!loc.length && lastExperience.location) {
        loc.push(lastExperience.location);
      }
      return loc;
    }
    const location = findLocation();

    // Calculate year
    const end = lastExperience.ends_at
      ? new Date(`${lastExperience.ends_at.year}-${lastExperience.ends_at.month}-${lastExperience.ends_at.day}`)
      : new Date();
    const start = lastExperience.starts_at
      ? new Date(`${lastExperience.starts_at.year}-${lastExperience.starts_at.month}-${lastExperience.starts_at.day}`)
      : new Date();
    const year = end.getFullYear() - start.getFullYear();

    return { company, position, location, year };
  } catch {
    // Return empty object if fetching LinkedIn fails
    return {};
  }
}

/**
 * Fetch salary info from RapidAPI's "Job Salary Data" service
 * API docs: https://rapidapi.com/letscrape-6bRBa3QguO5/api/job-salary-data
 */
async function fetchSalary(position: string, location: string): Promise<any> {
  const url = `https://job-salary-data.p.rapidapi.com/job-salary?job_title=${encodeURIComponent(
    position
  )}&location=${encodeURIComponent(location)}&location_type=ANY&years_of_experience=ALL`;
  const res = await fetch(url, {
    method: "GET",
    headers: new Headers({
      "x-rapidapi-key": RAPIDAPI_KEY as string,
      "x-rapidapi-host": "job-salary-data.p.rapidapi.com",
    }),
  });
  if (res.status !== 200) {
    throw new Error(`Failed to fetch salary data for ${position}, ${location}: ${res.statusText}`);
  }

  return await res.json();
}
const fetchSalaryCached = memory.cache(fetchSalary);

/**
 * Estimate salary based on the company, position, and location.
 * For location that has commas (e.g., "Hong Kong, China"), split and attempt multiple queries.
 */
async function estimateSalary(company: string, position: string, location: string): Promise<[number, string, string]> {
  const locations = location.split(", ");
  for (const loc of locations) {
    try {
      const res = await fetchSalaryCached(position, loc);
      if (res.data?.[0]?.median_salary > 0) {
        const salary = res.data[0].median_salary ?? -1;
        const currency = res.data[0].salary_currency ?? "USD";
        const period = res.data[0].salary_period ?? "YEAR";
        return [salary, currency, period];
      }
    } catch {
      // Ignore and try next
    }
  }
  return [0, "XXX", "XXX"];
}

/** 
 * Helper to find the median of an array of numbers.
 * If there's an even number of elements, return the average of the two middle values.
 */
function medianValue(vals: number[]): number {
  if (!vals.length) return 0;
  const sorted = [...vals].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  } else {
    return sorted[mid];
  }
}

/**
 * For a single user, complete LinkedIn username, fetch LinkedIn data, fetch salary...
 * Difference from before: as long as there is a LinkedIn username, return the result (even if company/position cannot be fetched)
 * Added: track how LinkedIn data was obtained (direct / inferred)
 */
async function enrichOneUser(user: GitHubSearchResult): Promise<ExpectedResult | null> {
  let { githubUsername, location, linkedinUsername, personalWebsite, reposCount } = user;
  location = location || "";

  let linkedinType: "direct" | "inferred" | undefined = undefined;

  // If LinkedIn username is not available, try to fetch from website
  if (!linkedinUsername && personalWebsite) {
    try {
      const inferredUsername = await getLinkedinFromWebsiteCached(personalWebsite);
      if (inferredUsername) {
        linkedinUsername = inferredUsername;
        linkedinType = "inferred";
      }
    } catch (err) {
      console.warn(`[${githubUsername}] getLinkedinFromWebsite failed: ${err}`);
    }
  }

  // If still not found, scrape the GitHub profile HTML for a LinkedIn URL
  if (!linkedinUsername) {
    try {
      const githubLinkedinUsername = await getLinkedinFromGitHubCached(githubUsername);
      if (githubLinkedinUsername) {
        linkedinUsername = githubLinkedinUsername;
        linkedinType = linkedinType || "inferred";
      }
    } catch (err) {
      console.warn(`[${githubUsername}] getLinkedinFromGitHub failed: ${err}`);
    }
  }

  // Determine the source of LinkedIn data
  if (linkedinUsername) {
    if (!linkedinType) {
      // If LinkedIn username was initially present, it's direct
      linkedinType = "direct";
    }
  } else {
    // If LinkedIn is still not available, return null
    return null;
  }

  let company = "";
  let position = "";
  let year: number | undefined = undefined;
  let salaryDollar = 0;
  let salaryCurrency = "USD";
  let salaryPeriod = "YEAR";

  // Fetch LinkedIn data
  let linkedinData: LinkedinResult = {};
  try {
    linkedinData = await getLinkedInData(linkedinUsername);
  } catch (err) {
    console.warn(`[${githubUsername}] getLinkedInData failed: ${err}`);
    linkedinData = {};
  }

  // Populate company, position, location, and years of experience
  company = linkedinData.company || "";
  position = linkedinData.position || "";
  if (Array.isArray(linkedinData.location)) {
    location = linkedinData.location.join(", ");
  } else if (linkedinData.location) {
    location = linkedinData.location;
  }
  year = linkedinData.year;

  // Attempt to estimate salary (only if company/position/location are available)
  if (company && position && location) {
    try {
      let [salaryVal, cur, period] = await estimateSalary(company, position, location);
      if (salaryVal > 0) {
        // Convert to USD if necessary
        if (cur !== "USD") {
          try {
            salaryVal = await convertToUSDCached(salaryVal, cur);
            cur = "USD";
          } catch {
            // Ignore conversion error
          }
        }
        // Convert monthly salary to yearly
        if (period === "MONTH") {
          salaryVal = salaryVal * 12;
          period = "YEAR";
        }
        salaryDollar = salaryVal;
        salaryCurrency = cur;
        salaryPeriod = period;
      }
    } catch (err) {
      console.warn(`[${githubUsername}] estimateSalary failed: ${err}`);
    }
  }

  // Return the result regardless of LinkedIn data completeness (as long as LinkedIn username exists)
  console.log(`[${githubUsername}] Enriched with LinkedIn data.`);
  return {
    githubUsername,
    reposCount,
    company,
    location,
    position,
    year,
    salaryDollar,
    salaryCurrency,
    salaryPeriod,
    linkedinUsername,
    personalWebsite,
    linkedinType, // New field
  };
}

/**
 * Main logic: concurrently fetch GitHub data -> concurrently fetch user details -> concurrently enrich -> generate results
 * Maintains async generator form here, but most results will be returned at once after processing all.
 */
export async function* search(query: string): AsyncGenerator<ExpectedResult> {
  // 1) Concurrently fetch GitHub
  const allUsernames = await fetchAllGitHubSearch(query);
  console.log(`Found ${allUsernames.length} unique usernames from GitHub search.`);

  // 2) Concurrently fetch each user's brief information
  const users = await fetchUsersDetail(allUsernames);
  console.log(`Got detail info of ${users.length} users (excluding organizations or failed).`);
  

  // 3b) Concurrently enrich with LinkedIn / salary, etc.
  const settledEnriched = await Promise.allSettled(
    users.map((u) => enrichOneUser(u))
  );

  // 4) Filter to only include fulfilled and non-null results
  const finalResults: ExpectedResult[] = [];
  for (const r of settledEnriched) {
    if (r.status === "fulfilled" && r.value) {
      finalResults.push(r.value);
    }
  }

  // Statistics for completed/incomplete job information
  let completedJobData = 0,
    incompleteJobData = 0,
    hasSalary = 0,
    noSalary = 0;

  // Statistics for LinkedIn types
  let directLinkedin = 0,
    inferredLinkedin = 0,
    noLinkedin = 0;

  for (const r of finalResults) {
    // Count based on linkedinType
    if (r.linkedinType === "direct") {
      directLinkedin++;
    } else if (r.linkedinType === "inferred") {
      inferredLinkedin++;
    }

    // Determine if job information is complete
    if (r.company && r.position) {
      completedJobData++;
    } else {
      incompleteJobData++;
    }

    // Determine if salary information is available
    if ((r.salaryDollar ?? 0) > 0) {
      hasSalary++;
    } else {
      noSalary++;
    }
  }

  const totalResults = finalResults.length;

  // Salary statistics
  const salaries = finalResults.map((r) => r.salaryDollar ?? 0).filter((s) => s > 0);
  const minSalary = salaries.length ? Math.min(...salaries) : 0;
  const maxSalary = salaries.length ? Math.max(...salaries) : 0;
  const medianSalary = medianValue(salaries);

  // Repository statistics
  const repoCounts = finalResults.map((r) => r.reposCount ?? 0).filter((r) => r >= 0);
  const minRepo = repoCounts.length ? Math.min(...repoCounts) : 0;
  const maxRepo = repoCounts.length ? Math.max(...repoCounts) : 0;
  const medianRepo = medianValue(repoCounts);

  // Location frequency
  const locationMap: Record<string, number> = {};
  for (const r of finalResults) {
    const splitLocation = r.location.split(", ");
    const loc = splitLocation[splitLocation.length - 1] || "Unknown";
    locationMap[loc] = (locationMap[loc] || 0) + 1;
  }
  const sortedLocations = Object.entries(locationMap).sort((a, b) => b[1] - a[1]);
  const top5Locations = sortedLocations.slice(0, 5);

  const summaryStats = {
    users: users.length,
    directLinkedin,
    inferredLinkedin,
    noLinkedin: users.length - directLinkedin - inferredLinkedin,
    completedJobData,
    incompleteJobData,
    hasSalary,
    noSalary,
    totalResults,
    salaryStats: {
      minSalary,
      maxSalary,
      medianSalary: Number(medianSalary.toFixed(2)),
    },
    repoCountStats: {
      minRepo,
      maxRepo,
      medianRepo: Number(medianRepo.toFixed(2)),
    },
    top5Locations,
  };

  console.log("--- Summary stats ---\n", summaryStats);

  // Write to file
  try {
    await fs.mkdir("exports", { recursive: true });
    await fs.writeFile(
      "exports/finalResults.json",
      JSON.stringify(
        {
          summary: summaryStats,
          results: finalResults,
        },
        null,
        2
      )
    );
    console.log("Export to file success.");
  } catch (err) {
    console.warn("Export to file failed:", err);
  }

  // Finally, yield each final result
  for (const r of finalResults) {
    yield r;
  }
}

(async () => {
  try {
    // Just a sample query
    const queryString = 'language:Python language:JavaScript in:readme "product management"';
    
    // Use for-await-of to get the results
    for await (const partialResult of search(queryString)) {
      console.log("Partial result:", partialResult);
    }
    console.log("All results have been processed.");
  } catch (error) {
    console.error("Error:", error);
  }
})();