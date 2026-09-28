'use strict';

// A scheduling adapter that schedules nothing, since Ghost has no setting
// that turns its scheduler off on its own.
// See ../README.md#the-export-colour-sends-nothing-and-schedules-nothing-the-second-layer.
function defineSchedulingDisabled(SchedulingBase) {
  return class SchedulingDisabled extends SchedulingBase {
    constructor(...args) {
      super(...args);
      // Read by Ghost's boot before it calls rescheduleAll().
      this.rescheduleOnBoot = false;
    }

    run() {}

    schedule() {}

    unschedule() {}

    async rescheduleAll() {
      return [];
    }
  };
}

module.exports = { defineSchedulingDisabled };
