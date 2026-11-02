#define FUSE_USE_VERSION 35
#define _FILE_OFFSET_BITS 64
#include <fuse3/fuse.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/time.h>
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define REQUEST_LIMIT (1024U * 1024U)
static const char *bridge_socket;
static uid_t owner_uid;
static gid_t owner_gid;

static uint64_t read64(const unsigned char *p) {
    uint32_t high, low;
    memcpy(&high, p, 4); memcpy(&low, p + 4, 4);
    return ((uint64_t)ntohl(high) << 32) | ntohl(low);
}
static void write32(unsigned char *p, uint32_t n) {
    uint32_t value = htonl(n);
    memcpy(p, &value, 4);
}
static void write64(unsigned char *p, uint64_t n) {
    write32(p, (uint32_t)(n >> 32));
    write32(p + 4, (uint32_t)n);
}
static int transfer(int fd, void *buffer, size_t length, int sending) {
    unsigned char *cursor = buffer;
    while (length) {
        ssize_t count = sending ? send(fd, cursor, length, MSG_NOSIGNAL) : recv(fd, cursor, length, 0);
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) return -EIO;
        cursor += count;
        length -= (size_t)count;
    }
    return 0;
}
static int request(uint32_t op, const char *path, uint64_t offset, uint32_t size,
                   uint32_t flags, const void *input, size_t input_size,
                   void *output, size_t capacity, size_t *output_size) {
    size_t path_size = strlen(path);
    if (!path_size || path_size > 4096 || input_size > REQUEST_LIMIT || size > REQUEST_LIMIT) return -EINVAL;
    int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
    if (fd < 0) return -errno;
    struct sockaddr_un address = {.sun_family = AF_UNIX};
    if (strlen(bridge_socket) >= sizeof(address.sun_path)) { close(fd); return -ENAMETOOLONG; }
    memcpy(address.sun_path, bridge_socket, strlen(bridge_socket) + 1);
    struct timeval deadline = {.tv_sec = 60};
    if (setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &deadline, sizeof(deadline)) < 0
        || setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &deadline, sizeof(deadline)) < 0) {
        close(fd); return -EIO;
    }
    if (connect(fd, (struct sockaddr *)&address, sizeof(address)) < 0) { close(fd); return -EIO; }
    unsigned char header[32] = {0};
    memcpy(header, "KFS1", 4);
    write32(header + 4, op);
    write32(header + 8, (uint32_t)path_size);
    write32(header + 12, (uint32_t)input_size);
    write64(header + 16, offset);
    write32(header + 24, size);
    write32(header + 28, flags);
    int result = transfer(fd, header, sizeof(header), 1);
    if (!result) result = transfer(fd, (void *)path, path_size, 1);
    if (!result && input_size) result = transfer(fd, (void *)input, input_size, 1);
    unsigned char response[8];
    if (!result) result = transfer(fd, response, sizeof(response), 0);
    if (!result) {
        uint32_t status, length;
        memcpy(&status, response, 4); status = ntohl(status);
        memcpy(&length, response + 4, 4); length = ntohl(length);
        if (status) result = status <= 4095 ? -(int)status : -EIO;
        else if (length > capacity || length > REQUEST_LIMIT) result = -EIO;
        else {
            if (length) result = transfer(fd, output, length, 0);
            if (!result && output_size) *output_size = length;
        }
    }
    close(fd);
    return result;
}
static int native_getattr(const char *path, struct stat *st, struct fuse_file_info *fi) {
    (void)fi;
    unsigned char body[32];
    size_t length = 0;
    int result = request(1, path, 0, 0, 0, NULL, 0, body, sizeof(body), &length);
    if (result) return result;
    if (length != sizeof(body)) return -EIO;
    uint32_t kind, mode;
    memcpy(&kind, body, 4); kind = ntohl(kind);
    memcpy(&mode, body + 4, 4); mode = ntohl(mode);
    if (kind != 1 && kind != 2) return -EIO;
    memset(st, 0, sizeof(*st));
    st->st_mode = (kind == 1 ? S_IFREG : S_IFDIR) | (mode & 0777);
    st->st_nlink = kind == 1 ? 1 : 2;
    st->st_uid = owner_uid; st->st_gid = owner_gid;
    st->st_size = (off_t)read64(body + 8);
    st->st_blksize = 65536;
    st->st_blocks = (st->st_size + 511) / 512;
    uint64_t modified = read64(body + 16);
    st->st_mtim.tv_sec = (time_t)(modified / 1000);
    st->st_mtim.tv_nsec = (long)((modified % 1000) * 1000000);
    st->st_atim = st->st_mtim; st->st_ctim = st->st_mtim;
    return 0;
}
static int native_readdir(const char *path, void *buffer, fuse_fill_dir_t filler,
                          off_t offset, struct fuse_file_info *fi, enum fuse_readdir_flags flags) {
    (void)fi; (void)flags;
    unsigned char *body = malloc(REQUEST_LIMIT);
    if (!body) return -ENOMEM;
    size_t length = 0;
    int result = request(2, path, 0, 0, 0, NULL, 0, body, REQUEST_LIMIT, &length);
    if (result || length < 4) { free(body); return result ? result : -EIO; }
    uint32_t count;
    memcpy(&count, body, 4); count = ntohl(count);
    if (offset == 0 && filler(buffer, ".", NULL, 1, 0)) { free(body); return 0; }
    if (offset <= 1 && filler(buffer, "..", NULL, 2, 0)) { free(body); return 0; }
    size_t cursor = 4;
    for (uint32_t i = 0; i < count; ++i) {
        if (cursor + 4 > length) { result = -EIO; break; }
        uint32_t size;
        memcpy(&size, body + cursor, 4); size = ntohl(size); cursor += 4;
        if (!size || size > 4096 || cursor + size > length) { result = -EIO; break; }
        if (memchr(body + cursor, 0, size) || memchr(body + cursor, '/', size)) { result = -EIO; break; }
        char name[4097];
        memcpy(name, body + cursor, size); name[size] = 0; cursor += size;
        if (offset <= (off_t)i + 2 && filler(buffer, name, NULL, (off_t)i + 3, 0)) break;
    }
    free(body);
    return result;
}
static void native_cache_policy(const char *path, struct fuse_file_info *fi) {
    size_t length = strlen(path);
    /* SQLite's reconstructible WAL index requires shared mmap; the DB and WAL
       retain synchronous direct I/O. libfuse 3.14 cannot mmap direct-I/O files. */
    fi->direct_io = !(length >= 4 && !strcmp(path + length - 4, "-shm"));
    fi->keep_cache = 0;
}
static int native_open(const char *path, struct fuse_file_info *fi) {
    struct stat st;
    int result = native_getattr(path, &st, fi);
    if (!result && !S_ISREG(st.st_mode)) return -EISDIR;
    native_cache_policy(path, fi);
    return result;
}
static int native_create(const char *path, mode_t mode, struct fuse_file_info *fi) {
    int result = request(3, path, 0, 0, mode & 0777, NULL, 0, NULL, 0, NULL);
    native_cache_policy(path, fi);
    return result;
}
static int native_mkdir(const char *path, mode_t mode) {
    return request(4, path, 0, 0, mode & 0777, NULL, 0, NULL, 0, NULL);
}
static int native_read(const char *path, char *buffer, size_t size, off_t offset, struct fuse_file_info *fi) {
    (void)fi;
    if (offset < 0 || size > REQUEST_LIMIT) return -EINVAL;
    size_t count = 0;
    int result = request(5, path, (uint64_t)offset, (uint32_t)size, 0, NULL, 0, buffer, size, &count);
    return result ? result : (int)count;
}
static int native_write(const char *path, const char *buffer, size_t size, off_t offset, struct fuse_file_info *fi) {
    (void)fi;
    if (offset < 0 || size > REQUEST_LIMIT) return -EINVAL;
    int result = request(6, path, (uint64_t)offset, 0, 0, buffer, size, NULL, 0, NULL);
    return result ? result : (int)size;
}
static int native_truncate(const char *path, off_t size, struct fuse_file_info *fi) {
    (void)fi;
    if (size < 0) return -EINVAL;
    return request(7, path, (uint64_t)size, 0, 0, NULL, 0, NULL, 0, NULL);
}
static int native_unlink(const char *path) { return request(8, path, 0, 0, 0, NULL, 0, NULL, 0, NULL); }
static int native_rmdir(const char *path) { return request(9, path, 0, 0, 0, NULL, 0, NULL, 0, NULL); }
static int native_rename(const char *path, const char *destination, unsigned int flags) {
    if (flags) return -EINVAL;
    return request(10, path, 0, 0, 0, destination, strlen(destination), NULL, 0, NULL);
}
static int native_sync(const char *path, int datasync, struct fuse_file_info *fi) {
    (void)datasync; (void)fi;
    return request(11, path, 0, 0, 0, NULL, 0, NULL, 0, NULL);
}
static int native_flush(const char *path, struct fuse_file_info *fi) {
    return native_sync(path, 0, fi);
}
static int native_chmod(const char *path, mode_t mode, struct fuse_file_info *fi) {
    (void)fi;
    return request(12, path, 0, 0, mode & 0777, NULL, 0, NULL, 0, NULL);
}
static int native_utimens(const char *path, const struct timespec times[2], struct fuse_file_info *fi) {
    (void)fi;
    if (times[1].tv_nsec == UTIME_OMIT) return 0;
    uint64_t milliseconds;
    if (times[1].tv_nsec == UTIME_NOW) {
        struct timespec now;
        if (clock_gettime(CLOCK_REALTIME, &now)) return -errno;
        milliseconds = (uint64_t)now.tv_sec * 1000 + (uint64_t)now.tv_nsec / 1000000;
    } else {
        if (times[1].tv_sec < 0) return -EINVAL;
        milliseconds = (uint64_t)times[1].tv_sec * 1000 + (uint64_t)times[1].tv_nsec / 1000000;
    }
    return request(13, path, milliseconds, 0, 0, NULL, 0, NULL, 0, NULL);
}
static void *native_init(struct fuse_conn_info *connection, struct fuse_config *config) {
    connection->want &= ~FUSE_CAP_WRITEBACK_CACHE;
    connection->max_write = REQUEST_LIMIT;
    config->entry_timeout = 0; config->negative_timeout = 0; config->attr_timeout = 0;
    config->kernel_cache = 0; config->auto_cache = 0; config->nullpath_ok = 0;
    return NULL;
}
int main(int argc, char **argv) {
    if (argc < 3) {
        fprintf(stderr, "usage: kala-native-fuse SOCKET MOUNTPOINT [fuse options]\n");
        return 2;
    }
    bridge_socket = argv[1];
    owner_uid = getuid(); owner_gid = getgid();
    const struct fuse_operations operations = {
        .init = native_init, .getattr = native_getattr, .readdir = native_readdir,
        .open = native_open, .create = native_create, .mkdir = native_mkdir,
        .read = native_read, .write = native_write, .truncate = native_truncate,
        .unlink = native_unlink, .rmdir = native_rmdir, .rename = native_rename,
        .fsync = native_sync, .flush = native_flush, .chmod = native_chmod, .utimens = native_utimens,
    };
    argv[1] = argv[0];
    return fuse_main(argc - 1, argv + 1, &operations, NULL);
}
