import crypto from "crypto";
import cors from "cors";
import axios from "axios";
import express from "express";
import NodeCache from "node-cache";
import { getGithubUserAchievements } from "@whatscookin/github_user_badge_scraper";
import { compose } from "./compose.js";
import {
  removeNullAndUndefined,
  getRelevantGithubUserFieldsForComposeDB,
  achievementsAsArray,
} from "./utils.js";
import { CREATE_GITHUB_USER } from "./queries.js";
import { scrapeFiverrProfile } from "./fiverr_scraper.js";

const cache = new NodeCache();
const app = express();
const port = process.env.PORT || 3007;
const CERAMIC_QUERY_URL = process.env.CERAMIC_QUERY_URL;

app.use(express.json());
app.use(cors());

app.get("/get-github-profile/:userAccount", async function (req, res) {
  //  TECHDEBT
  //  This API will be removed once composedb implements the feature to query with fields
  //  https://forum.ceramic.network/t/queries-by-fields/260/6
  const { userAccount } = req.params;
  const queryUrl = `${CERAMIC_QUERY_URL}/get-github-profile/${userAccount}`;

  try {
    const result = await axios.get(queryUrl);
    res.status(200).json({ message: result.data });
  } catch (err) {
    let statusCode = err.response?.status || 500;
    let message = err.response?.data?.message || err.message;
    res.status(statusCode).json({ message });
  }
});

app.post("/auth/github", async function (req, res) {
  const { githubAuthCode, userAccount } = req.body;

  if (!githubAuthCode || !userAccount) {
    return res.status(400).json({
      message: "githubAuthCode and userAccount are required fields",
    });
  }

  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;
  const accessTokenUrl = process.env.GITHUB_ACCESS_TOKEN_URL;

  try {
    const { data } = await axios.post(
      accessTokenUrl,
      {},
      {
        params: {
          client_id: clientId,
          client_secret: clientSecret,
          code: githubAuthCode,
        },
        headers: { Accept: "application/json" },
      }
    );
    if (data.error) {
      return res.status(400).json({ message: data.error });
    }

    const { access_token } = data;

    const { data: githubUserData } = await axios.get(
      "https://api.github.com/user",
      {
        headers: { Authorization: `token ${access_token}` },
      }
    );

    const relevantUserData =
      getRelevantGithubUserFieldsForComposeDB(githubUserData);

    const { html_url } = relevantUserData;
    const achievements = await getGithubUserAchievements(html_url);
    const achievementsArray = achievementsAsArray(achievements);

    let variables = {
      ...relevantUserData,
      achievements: achievementsArray,
      user_account: userAccount,
    };
    variables = removeNullAndUndefined(variables);

    const composeDBResult = await compose.executeQuery(
      CREATE_GITHUB_USER,
      variables
    );

    if (composeDBResult.errors) {
      return res
        .status(500)
        .json({ message: composeDBResult.errors[0].message });
    }

    res
      .status(201)
      .json({ message: composeDBResult.data.createGithubUser.document });
  } catch (err) {
    let statusCode = err.response?.status || 500;
    let message = err.response?.data?.message || err.message;

    res.status(statusCode).json({ message });
  }
});

app.get("/get-fiverr-magic-link", async (req, res, next) => {
  const { userAccount } = req.query;
  const magicToken = crypto.randomBytes(16).toString("hex");
  cache.set(userAccount, magicToken, 900); // expires in 15 minutes

  res.status(201).json({ magicToken });
});

app.post("/fiverr-profile", async (req, res) => {
  const { url, userAccount } = req.body;
  const magicLink = cache.get(userAccount);

  if (!magicLink) {
    return res
      .status(401)
      .json({ message: "Please try to take a new token and try again" });
  }

  let profile;
  try {
    profile = await scrapeFiverrProfile(url);
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({ message: err.message });
    }
    return res.status(500).json({ message: "Something went wrong!" });
  }

  const indexOfMagicLink = profile.description.indexOf(magicLink);

  if (indexOfMagicLink === -1) {
    return res.status(403).json({ message: "Token not found in description." });
  }

  profile = removeNullAndUndefined(profile);

  const CREATE_FIVERR_PROFILE = `
    mutation (
      $user_account: String!
      $name: String!
      $location: String
      $education: [FiverrProfileEducationInput]
      $description: String
      $overallRating: Float
      $languages: [FiverrProfileLanguageProficiencyInput]
      $skills: [String]
      $notableClients: [String]
      $numOfReviews: Int
      $ratingBreakdown: [FiverrProfileRatingBreakdownInput]
      $starCounters: [FiverrProfileStarCountersInput]
      $skillTests: [FiverrProfileSkillTestsInput]
    ) {
      createFiverrProfile(
        input: {
          content: {
            user_account: $user_account
            name: $name
            location: $location
            education: $education
            description: $description
            overallRating: $overallRating
            languages: $languages
            skills: $skills
            notableClients: $notableClients
            numOfReviews: $numOfReviews
            ratingBreakdown: $ratingBreakdown
            starCounters: $starCounters
            skillTests: $skillTests
          }
        }
      ){
        document {
          id
          user_account
          name
          location
          education {
            degree
            institution
          }
          description
          overallRating
          languages {
            lang
            proficiency
          }
          skills
          notableClients
          numOfReviews
          ratingBreakdown {
            type
            rating
          }
          starCounters {
            type
            count
          }
          skillTests {
            skill
            scorePercentage
            status
          }
        }
      }
    }
  `;

  const composeDBResult = await compose.executeQuery(CREATE_FIVERR_PROFILE, {
    user_account: userAccount,
    ...profile,
  });

  if (composeDBResult.errors) {
    return res.status(500).json({ message: composeDBResult.errors[0].message });
  }

  res.status(200).json({ message: composeDBResult });
});

app.listen(port, () => {
  console.log(`Credential Oracle server listening on the port ${port}`);
});
