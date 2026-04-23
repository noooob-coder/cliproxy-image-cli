#!/usr/bin/env node

const { main } = require("../lib/image-cli");

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    const message = error && error.message ? error.message : String(error);
    console.error(`Error: ${message}`);
    process.exitCode = 1;
  }
);
