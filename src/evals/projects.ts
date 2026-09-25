/**
 * Project files that the Java and Python eval tasks share (0.3). Plugin and library versions are
 * fixed, so a run does not depend on the Maven version's defaults, and one `garuda eval --prepare
 * java` fills ~/.m2 for every task.
 */

export const MAVEN_POM = `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
  <modelVersion>4.0.0</modelVersion>
  <groupId>dev.garuda.eval</groupId>
  <artifactId>eval</artifactId>
  <version>1.0.0</version>

  <properties>
    <maven.compiler.release>17</maven.compiler.release>
    <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
  </properties>

  <dependencies>
    <dependency>
      <groupId>org.junit.jupiter</groupId>
      <artifactId>junit-jupiter</artifactId>
      <version>5.11.4</version>
      <scope>test</scope>
    </dependency>
  </dependencies>

  <build>
    <plugins>
      <plugin>
        <groupId>org.apache.maven.plugins</groupId>
        <artifactId>maven-resources-plugin</artifactId>
        <version>3.3.1</version>
      </plugin>
      <plugin>
        <groupId>org.apache.maven.plugins</groupId>
        <artifactId>maven-compiler-plugin</artifactId>
        <version>3.13.0</version>
      </plugin>
      <plugin>
        <groupId>org.apache.maven.plugins</groupId>
        <artifactId>maven-surefire-plugin</artifactId>
        <version>3.5.2</version>
      </plugin>
    </plugins>
  </build>
</project>
`;

/**
 * The check for Java tasks. `.mvn/maven.config` could add -DskipTests, so the check refuses a
 * .mvn folder (no task has one).
 */
export const MAVEN_CHECK = "test ! -e .mvn && mvn -B -q -o test";

export const PYPROJECT = `[project]
name = "evalpkg"
version = "0.1.0"
requires-python = ">=3.9"

[tool.pytest.ini_options]
pythonpath = ["src"]
testpaths = ["tests"]
`;

/**
 * The check for Python tasks. It reads only pyproject.toml (protected) and no conftest.py, so a
 * new pytest.ini or conftest.py cannot skip the tests.
 */
export const PYTEST_CHECK =
  "python3 -m pytest -q -c pyproject.toml --noconftest -p no:cacheprovider";

/** Files that no task may change: tests and build files. */
export function isProtectedPath(path: string): boolean {
  return /^(test|tests|src\/test)\//.test(path) || path === "pom.xml" || path === "pyproject.toml";
}

export const lines = (...l: string[]) => `${l.join("\n")}\n`;
