const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const { CleanWebpackPlugin } = require('clean-webpack-plugin');
const CopyWebpackPlugin = require('copy-webpack-plugin');
const webpack = require("webpack");
const dotenv = require("dotenv");

// Load environment variables from .env file
const env = dotenv.config().parsed;

// Create an object with environment variables prefixed with REACT_APP_ or custom prefix
const envKeys = Object.keys(env || {}).reduce((prev, next) => {
  prev[`process.env.${next}`] = JSON.stringify(env[next]);
  return prev;
}, {});

module.exports = {
  // Note:
  // Chrome MV3 no longer allowed remote hosted code
  // Using module bundlers we can add the required code for your extension
  // Any modular script should be added as entry point
  entry: {
    popup: "./src/popup/popup.js",
    main_script: "./src/popup/main-script.js",
    options: "./src/options/options.js",
  },
  resolve: {
    fallback: {
      vm: require.resolve("vm-browserify"),
      crypto: require.resolve("crypto-browserify"),
      stream: require.resolve("stream-browserify"),
      buffer: require.resolve("buffer"),
      process: require.resolve("process/browser"),
    },
  },
  plugins: [
    new CleanWebpackPlugin({ cleanStaleWebpackAssets: false }),

    // Define environment variables
    new webpack.DefinePlugin(envKeys),

    new HtmlWebpackPlugin({
      template: path.join(__dirname, "src", "popup", "popup.html"),
      filename: "popup.html",
      chunks: ["popup"], // This is script from entry point
    }),
    // Note: you can add as many new HtmlWebpackPlugin objects
    // filename: being the html filename
    // chunks: being the script src
    // if the script src is modular then add it as the entry point above
    new HtmlWebpackPlugin({
      template: path.join(__dirname, "src", "options", "options.html"),
      filename: "options.html",
      chunks: ["options"], // This is script from entry point
    }),
    new HtmlWebpackPlugin({
      template: path.join(__dirname, "src", "popup", "main.html"),
      filename: "main.html",
      chunks: ["main_script"], // This is script from entry point
    }),
    // Note: This is to copy any remaining files to bundler
    new CopyWebpackPlugin({
      patterns: [
        { from: "./src/manifest.json" },
        { from: "./src/background/background.js" },
        { from: "./src/content/content.js" },
        { from: "./src/icons/*" },
        { from: "./src/css/*" },
        // { from: "./src/image", to: "image" },
      ],
    }),
    new webpack.ProvidePlugin({
      Buffer: ["buffer", "Buffer"],
      process: "process/browser",
    }),
  ],
  output: {
    // chrome load uppacked extension looks for files under dist/* folder
    filename: "[name].js",
    path: path.resolve(__dirname, "dist"),
  },
  mode: "development", // or 'production'
};