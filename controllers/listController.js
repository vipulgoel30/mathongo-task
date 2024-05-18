// Core Modules
import { join, dirname } from "path";
import { createReadStream, existsSync, unlink } from "fs";
import { fileURLToPath } from "url";
import { promisify } from "util";

// Third party imports
import { isObjectIdOrHexString } from "mongoose";
import { parse } from "fast-csv";
import isEmail from "validator/lib/isEmail.js";
import { createObjectCsvStringifier } from "csv-writer";

// User imports
import List from "../models/List.js";
import AppError from "../utils/AppError.js";
import catchAsync from "../utils/catchAsync.js";
import User from "../models/User.js";
import sendMailHandler from "../utils/email.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const unlinkAsync = (path) => promisify(unlink)(path);

export const createList = catchAsync(async (req, res, next) => {
  const title = req.body.title?.trim();
  if (!title) return next(new AppError("Missing required field: 'title'", 400));

  const list = await List.create(req.body);

  res.status(201).json({
    status: "success",
    message: "List created successfully",
    data: { list },
  });
});

export const getList = catchAsync(async (req, res, next) => {
  let { limit, page } = req.query;
  if (!limit) limit = 20;
  if (!page) page = 1;

  const lists = await List.find()
    .select("-__v")
    .limit(limit)
    .skip(limit * (page - 1))
    .lean();

  res.status(200).json({
    status: "success",
    message: "Lists fetched successfully",
    data: {
      length: lists.length,
      lists: lists,
    },
  });
});

const invalidListIdErr = new AppError("The provided list ID is not valid. Please check the ID and try again.", 400);

export const verifyID = (req, res, next) => {
  const { id } = req.params;
  if (!isObjectIdOrHexString(id)) return next(invalidListIdErr);
  next();
};

export const getListById = catchAsync(async (req, res, next) => {
  let { limit, page } = req.query;
  if (!limit) limit = 100;
  if (!page) page = 1;

  const list = await List.findById(req.params.id)
    .populate({
      path: "users",
      options: {
        limit: limit,
        skip: (page - 1) * limit,
      },
    })
    .lean();
  if (!list) return next(invalidListIdErr);

  res.status(200).json({
    status: "success",
    message: "List fetched successfully",
    data: { list: list },
  });
});

export const addUser = async (req, res, next) => {
  try {
    if (!req.file) throw new AppError("Please provide the csv file for the users", 400);

    const list = await List.findById(req.params.id).lean();
    if (!list) throw new AppError("No list found with that ID", 400);

    const readStream = createReadStream(join(__dirname, "./../files", req.file.originalname));

    readStream.on("error", (err) => {
      return res.status(500).json({
        status: "error",
        message: "Uhh! Something went wrong on the server",
      });
    });

    const csvStream = readStream.pipe(parse({ headers: true }));

    const userErrors = [];
    let rowsCount = 0;
    const maxBatches = 6;
    let maxBatchSize = 10;

    const processBatch = async (batch) => {
      rowsCount += batch.length;
      const usersPromise = batch.map(async (row) => {
        const { name, email } = row;
        if (!name) {
          userErrors.push({ ...row, error: "Name is invalid" });
          return;
        }
        if (!email || !isEmail(email)) {
          userErrors.push({ ...row, error: "Email is invalid" });
          return;
        }

        const existingUser = await User.findOne({ email, list: list._id }).lean();
        if (existingUser) {
          userErrors.push({ ...row, error: "User already exists" });
          return null;
        }

        const payload = { isSubscribed: true };
        Object.keys(row).map((field) => (payload[field] = row[field] || list[field]));
        return { ...payload, list: list._id };
      });

      const users = (await Promise.all(usersPromise)).filter((user) => user);
      if (users.length > 0)
        try {
          await User.insertMany(users, { ordered: false, lean: true, throwOnValidationError: true });
        } catch (err) {
          users.forEach((user) => userErrors.push({ ...user, error: "Unknown error!!!" }));
        }
    };

    let activeBatches = 0;
    let currentBatch = [];
    let rowHeaders;
    csvStream.on("data", (row) => {
      if (!rowHeaders) rowHeaders = row;
      currentBatch.push(row);
      if (currentBatch.length > maxBatchSize) {
        if (activeBatches > maxBatches) {
          csvStream.pause();
        }
        maxBatchSize = Math.min(maxBatchSize * 2, 300);
        activeBatches++;
        processBatch(currentBatch).then(() => {
          activeBatches--;
          if (csvStream.isPaused()) {
            csvStream.resume();
          }
        });

        currentBatch = [];
      }
    });

    csvStream.on("error", (err) => {
      return res.status(500).json({
        status: "error",
        message: "Uhh! Something went wrong on the server",
      });
    });

    csvStream.on("end", async () => {
      if (currentBatch.length > 0) {
        await processBatch(currentBatch);
      }
      const updatedList = await List.findById(req.params.id).populate({ path: "usersCount" });

      const csvStringifierStats = createObjectCsvStringifier({
        header: [
          { id: "addedCount", title: "Added Users Count" },
          { id: "notAddedCount", title: "Not Added Users Count" },
          { id: "currentTotalUsers", title: "Total Users" },
        ],
      });

      const recordsStats = [
        {
          addedCount: rowsCount - userErrors.length,
          notAddedCount: userErrors.length,
          currentTotalUsers: updatedList.usersCount,
        },
      ];

      const stats = csvStringifierStats.getHeaderString() + csvStringifierStats.stringifyRecords(recordsStats);

      const csvStringifierErrors = createObjectCsvStringifier({
        header: [
          ...Object.keys(rowHeaders).map((header) => ({ id: header, title: header.toUpperCase() })),
          { id: "error", title: "ERROR" },
        ],
      });

      const errors = csvStringifierErrors.getHeaderString() + csvStringifierErrors.stringifyRecords(userErrors);

      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", 'attachment; filename="data.csv"');
      res.status(200).send(stats + "\n" + errors);
    });
  } catch (err) {
    next(err);
  } finally {
    try {
      const inputFilePath = join(__dirname, "./../files", req.file.originalname);
      if (existsSync(inputFilePath)) unlinkAsync(inputFilePath);
    } catch (err) {}
  }
};

export const sendMail = catchAsync(async (req, res, next) => {
  const emailTemplate = req.body;
  if (!emailTemplate && emailTemplate.trim().length === 0)
    return next(new AppError("Please provide the email template", 400));

  const list = await List.findById(req.params.id).lean();
  if (!list) return next(new AppError("No list found with that ID", 400));

  const users = await User.find({ list: list._id }).select("-list").lean();

  const promises = users.map(async (user) => await sendMailHandler(user, list._id, emailTemplate));
  await Promise.all(promises);

  res.status(200).json({ status: "success", message: "Email sent successfully" });
});
