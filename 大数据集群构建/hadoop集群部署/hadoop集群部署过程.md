# Hadoop集群部署过程

> hadoop集群不适合部署在docker swarm集群上，swarm内部的网络问题很容易导致hadoop集群中节点之间的双向访问受阻，因此最好在宿主机上部署hadoop集群。

> 工作概述
> 1. 准备jdk
> 2. 准备hadoop包
> 3. 部署hadoop
>   a. 配置hadoop-env.sh，配置core-site.xml、hdfs-site.xml、yarn-site.xml文件
>   b. ～/.bashrc中配置hadoop_home等
> 4. 验证安装

## 1.1 集群规划
主要是规划 HDFS 和 YARN 的节点：
- 对于 HDFS，NameNode 和 SecondNameNode比较耗资源，不要放在同一个节点上，从容灾来讲，也不推荐放在一个节点上。
- 对于 YARN，ResourceManager比较耗资源，不推荐和 HDFS 的NN 和 2NN放在一个节点上。

||hadoop101|hadoop102|hadoop103|
|---|---|---|---|
|HDFS|DataNode、NameNode|DataNode|DataNode、SecondNameNode|
|YARN|NodeManager|NodeManager、ResourceManager|NodeManager|

## 1.2 准备JDK和环境变量
由于后续使用jdk11部署hadoop3.3.6，使用jdk17部署flink1.19，所以jdk必须分开，且不能导入到全局环境变量中。
因此，先将jdk统一下载到一个固定目录，比如`~/jdk/`下，然后在`~`下或其他目录比如`/usr/local/bin`下新建若干个sh脚本用于切换环境。

- 如图所示，将jdk11和jdk17下载并解压到`~/jdk/`下，并且运行`rsync`将jdk11和jdk17同步到三个节点上。
  ![](image/2026-03-28-15-30-08.png)

- 准备好`go-hadoop.sh`和`go-flink.sh`脚本，需要的时候直接`source go-xxx.sh`脚本就可以直接临时切换环境。

- `go-hadoop.sh`：
    ```sh
    export JAVA_HOME=/home/leoyi/jdk/jdk-11.0.2
    export HADOOP_HOME=/home/leoyi/module/hadoop-3.3.6
    export PATH=$JAVA_HOME/bin:$HADOOP_HOME/bin:$HADOOP_HOME/sbin:$PATH
    ```

- `go-flink.sh`:
    ```sh
    export JAVA_HOME=/home/leoyi/jdk/jdk-17.0.10+7
    export FLINK_HOME=/home/leoyi/module/flink-1.19
    export PATH=$JAVA_HOME/bin:$FLINK_HOME/bin:$PATH
    ```

## 1.3 准备hadoop文件
- 下载并解压hadoop3.3.6文件包，并解压到hadoop101的`~/module/`目录下，并使用以下脚本同步到hadoop102、hadoop103节点上。
  
```sh
rsync -av /home/leoyi/module/hadoop-3.3.6 leoyi@hadoop102:/home/leoyi/module/
rsync -av /home/leoyi/module/hadoop-3.3.6 leoyi@hadoop103:/home/leoyi/module/
```
![](image/2026-03-28-15-35-13.png)

## 1.4 准备hadoop配置文件
- hadoop配置文件都在`etc/hadoop/`下，需要修改的核心配置文件有以下五个：
  - `core-site.xml`：是hadoop的全局配置，决定了集群最基础的运行环境，定义元数据节点（namenode）的地址，以及hadoop运行时数据的临时存储目录。
  - `hdfs-site.xml`：决定HDFS系统的具体参数，例如副本数量和2NN的运行节点。
  - `yarn-site.xml`：决定YARN系统的运行规则，如果只使用flink on yarn的话，没有mapreduce任务的话，只配RM的运行节点就行。
  - `works`：配置工作节点，写在这个文件的主机名都作为worker（datanode和nodemanager）。
  - `hadoop-env.sh`：配置hadoop的运行环境变量，由于不配置全局的jdk环境变量，在这里要显式指定JDK路径。

- `core-site.xml`：
    ```xml
    <configuration>
        <!-- 【Flink 的重要基石】：指定 HDFS NameNode 的入口地址。
            以后你在 Flink 代码里配置 Checkpoint 容错路径时，
            直接写 "hdfs://hadoop101:8020/flink/checkpoints" 就是靠这个配置解析的。-->
        <property>
            <name>fs.defaultFS</name>
            <value>hdfs://hadoop101:8020</value>
        </property>

        <!-- 【避坑必备】：Hadoop 默认把元数据和数据存放在 Linux 的 /tmp 目录下。
            Ubuntu 系统重启会自动清空 /tmp，如果不改这个，你只要一重启虚拟机，HDFS 数据就全丢了。
            你把它改到了安装目录下，非常标准。-->
        <property>
            <name>hadoop.tmp.dir</name>
            <value>/home/leoyi/module/hadoop-3.3.6/data</value>
        </property>

        <!-- 【Mac 浏览器访问的福音】：因为你在 Mac 的 Safari 上看 HDFS Web UI，
            如果要在网页上点按钮删除文件、创建文件夹，Hadoop 默认会把你识别为 "dr.who" 这个无权限的匿名用户。
            配了这个，Hadoop 就会把你当成超级管理员 "leoyi"，在网页上操作 HDFS 畅通无阻。-->
        <property>
            <name>hadoop.http.staticuser.user</name>
            <value>leoyi</value>
        </property>
        
        <!-- 【HDFS 回收站】：删除文件后保留 1440 分钟（24小时）。
            以后你在调试 Flink 往 HDFS 写数据时，如果误删了，可以用命令找回来。-->
        <property>
            <name>fs.trash.interval</name>
            <value>1440</value>
        </property>
        <property>
            <name>fs.trash.checkpoint.interval</name>
            <value>60</value>
        </property>
    </configuration>
    ```
- `hdfs-site.xml`:
    ```xml
    <configuration>
        <!-- 【副本数】：因为你有 101、102、103 三个 DataNode，设置为 3 是最高可用性。
            你的 200G 硬盘跑学习场景，存 3 份完全没有存储压力。-->
        <property>
            <name>dfs.replication</name>
            <value>3</value>
        </property>

        <!-- 【SecondaryNameNode】：指定你的 2NN 部署在 103 节点上。
            它负责帮 NameNode 合并编辑日志，分担压力。-->
        <property>
            <name>dfs.namenode.secondary.http-address</name>
            <value>hadoop103:9868</value>
        </property>
    </configuration>
    ```
- `yarn-site.xml`:
    ```xml
    <configuration>
        <!-- 【YARN 的大脑】：指定 ResourceManager 在 hadoop102 上。
            你的 Flink 提交任务时，会主动找 102 申请资源。-->
        <property>
            <name>yarn.resourcemanager.hostname</name>
            <value>hadoop102</value>
        </property>
        
        <!-- 白名单：允许 NodeManager 继承这些环境变量，保障 Flink 在容器中能拿到正确的 Hadoop 路径 -->
        <property>
            <name>yarn.nodemanager.env-whitelist</name>
            <value>JAVA_HOME,HADOOP_COMMON_HOME,HADOOP_HDFS_HOME,HADOOP_CONF_DIR,CLASSPATH_PREPEND_DISTCACHE,HADOOP_YARN_HOME,HADOOP_MAPRED_HOME</value>
        </property>
        
        <!-- 【Tailscale 的神级配合】：如果不加 0.0.0.0，YARN 可能只绑定局域网 IP 或者 127.0.0.1。
            配了 0.0.0.0，你的 Mac 就可以直接通过 Tailscale 隧道，用 http://hadoop102:8088 访问界面了。-->
        <property>
            <name>yarn.resourcemanager.webapp.address</name>
            <value>0.0.0.0:8088</value>
        </property>
        
        <!-- 【极其关键：Flink 日志聚合】：Flink 在 YARN 上跑完后，打工人 (TaskManager) 会立刻销毁，本地日志也没了。
            开启这个，YARN 会在任务结束后，把 Flink 的报错日志打包上传到 HDFS。
            以后你可以通过 `yarn logs -applicationId xxx` 查错，否则任务挂了你连报错日志都找不到！-->
        <property>
            <name>yarn.log-aggregation-enable</name>
            <value>true</value>
        </property>
        <property>
            <name>yarn.log-aggregation.retain-seconds</name>
            <value>604800</value> <!-- 保留 7 天，正好对应你的一周学习计划 -->
        </property>
        <!--
            19888 端口是 MapReduce 的 HistoryServer 专属的！
            Flink 跑完后如果要看历史界面，用的是 Flink 自己的 HistoryServer (通常是 8082 端口)。
            所以这个配置对你没用，不过留着也不影响，只是死代码。-->
    <!--    <property>-->
    <!--        <name>yarn.log.server.url</name>-->
    <!--        <value>http://hadoop102:19888/jobhistory/logs</value>-->
    <!--    </property>-->

    <!--针对只跑flnk，不跑MR作业的场景，还可以做以下三个优化点-->
    <!-- 1. 告诉 YARN：这台虚拟机有多少内存可以分配给 Flink 用？
            如果不配，YARN 默认认为每台机器只有 8G 内存可用。
            你机器有 24G，我们可以大方一点，给 YARN 分配 16G (16384 MB)，剩下的留给 Ubuntu 系统和 HDFS。-->
        <property>
            <name>yarn.nodemanager.resource.memory-mb</name>
            <value>16384</value>
        </property>

        <!-- 2. 告诉 YARN：这台虚拟机有多少个 CPU 核心可用？
            默认是 8。但你明确说了你的 VM 是 4 核，如果不改，YARN 会超发导致 CPU 争抢。-->
        <property>
            <name>yarn.nodemanager.resource.cpu-vcores</name>
            <value>4</value>
        </property>

        <!-- 3. 【Flink on YARN 救命神配】：关闭虚拟内存检查。
            Flink 是个吃内存大户，尤其是在使用 RocksDB 状态后端或者较新的 JDK 时，
            它占用的虚拟内存（Vmem）往往会超过物理内存的 2.1 倍（YARN 的默认阈值）。
            如果不关掉这个检查，YARN 只要发现 Flink 虚拟内存超标，就会直接把 Flink 的 TaskManager "咔嚓" 杀掉！
            报错通常是：Container is running beyond virtual memory limits... -->
        <property>
            <name>yarn.nodemanager.vmem-check-enabled</name>
            <value>false</value>
        </property>
    </configuration>
    ```
- `hadoop-env.sh`:
    ```sh
    # Hadoop 的各个组件（NameNode, NodeManager等）在启动时，
    # 是通过 SSH 互相登录并拉起后台守护进程的。
    # 守护进程【无法】读取你在 FinalShell 里手动 source go-hadoop.sh 临时加载的环境变量！
    # 因此，必须在这里显式“硬编码” JDK 11 的路径，这是你双 JDK 隔离架构成功的基石。
    # 显式指定 JDK 路径
    export JAVA_HOME=/home/leoyi/jdk/jdk-11.0.2
    # 预防 HADOOP 找不到自身安装路径
    export HADOOP_HOME=/home/leoyi/module/hadoop-3.3.6
    ```

- `works`:
    ```txt
    hadoop101
    hadoop102
    hadoop103
    ```


## 1.5 准备一键启停部署脚本
启动一个完整的hadoop集群，要先去NN节点启动hdfs集群，然后去RM节点启动yarn集群，停止集群时，要先去RM节点关闭yarn集群，然后去NN节点关闭hdfs集群，所以准备一个一键启停脚本更为方便：

- cluster.sh
    ```sh
    #!/bin/bash

    # 定义 Hadoop 路径（绝对路径最稳妥）
    HADOOP_BIN=/home/leoyi/module/hadoop-3.3.6/bin
    HADOOP_SBIN=/home/leoyi/module/hadoop-3.3.6/sbin
    # 定义加载环境的命令（假设你的脚本路径固定）
    LOAD_ENV="source /home/leoyi/go-hadoop.sh"

    case $1 in
    "start")
        echo "================ 正在启动 HDFS (101) ================"
        # 在 101 本地启动，通过 bash -c 强制加载环境
        bash -c "$LOAD_ENV && $HADOOP_SBIN/start-dfs.sh"

        echo "================ 正在启动 YARN (102) ================"
        # 远程登录到 102，并在远程 Shell 中先加载环境再启动
        ssh hadoop102 "$LOAD_ENV && $HADOOP_SBIN/start-yarn.sh"
        ;;
    "stop")
        echo "================ 正在停止 YARN (102) ================"
        ssh hadoop102 "$LOAD_ENV && $HADOOP_SBIN/stop-yarn.sh"

        echo "================ 正在停止 HDFS (101) ================"
        bash -c "$LOAD_ENV && $HADOOP_SBIN/stop-dfs.sh"
        ;;
    "status")
        for host in hadoop101 hadoop102 hadoop103
        do
            echo "---------------- $host JPS 状态 ----------------"
            ssh $host "$LOAD_ENV && jps" | grep -v Jps
        done
        ;;
    *)
        echo "使用方法: cluster.sh [start|stop|status]"
        ;;
    esac
    ```

## 1.6 启停集群
通过1.5的脚本，直接运行以下命令，就可以启动集群了，停止集群同理。
- 启动集群：
    ```sh
    ./cluster.sh start
    ```
    ![](image/2026-03-28-16-30-36.png)

然后就可以去macos上的浏览器看hdfs和yarn集群状态了。
![](image/2026-03-28-16-31-25.png)
![](image/2026-03-28-16-31-36.png)