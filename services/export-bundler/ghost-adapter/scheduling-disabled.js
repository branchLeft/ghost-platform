'use strict';

// A scheduling adapter that schedules nothing. Ghost's scheduler is the one
// path that publishes a scheduled post, sends a scheduled newsletter or
// advances an automation, and Ghost has no setting that turns it off: the
// default adapter reschedules every scheduled post on boot and pings the
// site's own admin API when each is due. The export bundler boots a second
// Ghost process on a tenant's live database, and that process must never do
// any of it.
//
// Ghost only accepts an instance of its own SchedulingBase, so the class is
// built from the base the caller hands in (SchedulingDisabled.js passes
// Ghost's own).
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
