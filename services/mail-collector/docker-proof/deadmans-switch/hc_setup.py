# Run inside the healthchecks container via its own manage.py shell:
#   docker compose ... exec -T healthchecks python3 manage.py shell < hc_setup.py
#
# Creates one throwaway project and one throwaway simple check, entirely in
# a container whose sqlite database is destroyed with the container --
# nothing here is a credential for anything but this run.
from datetime import timedelta
from uuid import uuid4

from django.contrib.auth.models import User
from hc.accounts.models import Project
from hc.api.models import Check

username = "proof"
user, _ = User.objects.get_or_create(username=username, defaults={"email": "proof@example.invalid"})

project = Project.objects.create(owner=user, name="deadmans-switch-proof", badge_key=str(uuid4()))
api_key = project.set_api_key()
project.save()

# Two separate checks so the destructive stopped->down scenario cannot
# contaminate the idle/restart scenario that must stay up throughout.
idle_check = Check.objects.create(
    project=project,
    name="idle-and-restart-proof",
    timeout=timedelta(seconds=3),
    grace=timedelta(seconds=3),
)
stopped_check = Check.objects.create(
    project=project,
    name="stopped-proof",
    timeout=timedelta(seconds=3),
    grace=timedelta(seconds=3),
)

print("PROOF_API_KEY=%s" % api_key)
print("PROOF_IDLE_CHECK_CODE=%s" % idle_check.code)
print("PROOF_STOPPED_CHECK_CODE=%s" % stopped_check.code)
