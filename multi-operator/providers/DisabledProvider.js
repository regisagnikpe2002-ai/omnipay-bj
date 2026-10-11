"use strict";

const BaseProvider = require("./BaseProvider");

class DisabledProvider extends BaseProvider {
  constructor(config) {
    super(config);
  }
}

module.exports = DisabledProvider;
