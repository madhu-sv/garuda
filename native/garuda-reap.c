// garuda-reap (0.17, IPI-04): stop the processes that one sandboxed command left running on macOS.
//
// Seatbelt has no process namespace, so a process can leave the command's process group (setsid,
// setpgid, posix_spawn with POSIX_SPAWN_SETSID or POSIX_SPAWN_SETPGROUP) and outlive the command.
// It cannot leave its Seatbelt profile. Garuda puts two marker files in each command's profile:
// reads of <markerA> are denied, reads of <markerB> are allowed. After the command, this helper
// asks the kernel (sandbox_check) about every process of the current user and sends SIGKILL to
// each one that has A denied and B allowed. Processes without a sandbox allow both; App Store
// sandboxes deny both (the markers are outside their containers). So only the command's own
// processes match. It repeats the scan until a scan finds none (at most 10 scans), so children
// started during a scan are found in the next one.
//
//   garuda-reap <markerA> <markerB>          stop the matches; prints "killed <n>"
//   garuda-reap --list <markerA> <markerB>   only list the matches (tests)
//
// Exit codes: 0 done, 2 usage, 3 a marker file is missing, 4 the process list failed.
#include <errno.h>
#include <libproc.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/proc_info.h>
#include <sys/stat.h>
#include <unistd.h>

// From libsystem_sandbox (not in the public SDK headers).
enum sandbox_filter_type { SANDBOX_FILTER_NONE, SANDBOX_FILTER_PATH };
extern const enum sandbox_filter_type SANDBOX_CHECK_NO_REPORT;
int sandbox_check(pid_t pid, const char *operation, enum sandbox_filter_type type, ...);

#define MAX_SCANS 10
#define MAX_KILLED 4096

// Processes already sent SIGKILL: a killed process can show in the next scan until launchd reaps
// it, so it is counted once and does not keep the loop going.
static pid_t killed_pids[MAX_KILLED];
static int killed_count = 0;

static int already_killed(pid_t pid) {
  for (int i = 0; i < killed_count; i++)
    if (killed_pids[i] == pid) return 1;
  return 0;
}

static int denied(pid_t pid, const char *path) {
  return sandbox_check(pid, "file-read-data",
                       (enum sandbox_filter_type)(SANDBOX_FILTER_PATH | SANDBOX_CHECK_NO_REPORT), path);
}

// One scan. Returns the number of new matches, or -1 when the process list failed.
static int scan(const char *a, const char *b, int list_only) {
  int n = proc_listallpids(NULL, 0);
  if (n <= 0) return -1;
  size_t cap = (size_t)n + 256;
  pid_t *pids = calloc(cap, sizeof(pid_t));
  if (pids == NULL) return -1;
  n = proc_listallpids(pids, (int)(cap * sizeof(pid_t)));
  if (n <= 0) {
    free(pids);
    return -1;
  }
  uid_t me = getuid();
  pid_t self = getpid(), parent = getppid();
  int matches = 0;
  for (int i = 0; i < n; i++) {
    pid_t pid = pids[i];
    if (pid <= 1 || pid == self || pid == parent) continue;
    struct proc_bsdinfo info;
    if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof info) != (int)sizeof info) continue;
    if (info.pbi_uid != me) continue;
    if (denied(pid, a) == 1 && denied(pid, b) == 0) {
      if (list_only) {
        matches++;
        printf("match %d %d %s\n", pid, info.pbi_ppid, info.pbi_comm);
        continue;
      }
      kill(pid, SIGKILL);
      if (already_killed(pid)) continue;
      matches++;
      if (killed_count < MAX_KILLED) killed_pids[killed_count++] = pid;
    }
  }
  free(pids);
  return matches;
}

int main(int argc, char **argv) {
  int list_only = argc == 4 && strcmp(argv[1], "--list") == 0;
  if (argc != 3 && !list_only) {
    fprintf(stderr, "usage: garuda-reap [--list] <markerA> <markerB>\n");
    return 2;
  }
  const char *a = argv[argc - 2], *b = argv[argc - 1];
  struct stat st;
  // A missing marker reads as denied for every process, so nothing would match: refuse instead.
  if (stat(a, &st) != 0 || stat(b, &st) != 0) {
    fprintf(stderr, "garuda-reap: a marker file is missing\n");
    return 3;
  }
  if (list_only) return scan(a, b, 1) < 0 ? 4 : 0;
  for (int i = 0; i < MAX_SCANS; i++) {
    int found = scan(a, b, 0);
    if (found < 0) {
      fprintf(stderr, "garuda-reap: the process list failed (%s)\n", strerror(errno));
      return 4;
    }
    if (found == 0) break;
    usleep(10000);
  }
  printf("killed %d\n", killed_count);
  return 0;
}
