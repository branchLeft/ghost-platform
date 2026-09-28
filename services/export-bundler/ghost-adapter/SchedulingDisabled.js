'use strict';

// Ghost loads this file by name from core/server/adapters/scheduling/ when a
// colour's config sets adapters__scheduling__active=SchedulingDisabled. It is
// inert otherwise. It must require nothing Ghost's own image does not already
// resolve from that directory: a module that fails to load stops Ghost
// starting, which for the export colour fails the export closed.
const { SchedulingBase } = require('@tryghost/adapter-base-scheduling');
const { defineSchedulingDisabled } = require('./scheduling-disabled');

module.exports = defineSchedulingDisabled(SchedulingBase);
